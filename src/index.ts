/**
 * azure-openai-forwarder
 *
 * A Cloudflare Worker that acts as an OpenAI-compatible gateway in front of
 * an Azure OpenAI deployment.  It handles three core problems:
 *
 *  1. Protocol translation  – converts the newer OpenAI Responses API
 *     (/v1/responses) into Azure's Chat Completions format, so clients that
 *     use the latest OpenAI SDK work out of the box.
 *
 *  2. Fake streaming  – Azure's endpoint does not support SSE streaming.
 *     When a client requests stream=true, the Worker fetches a complete
 *     response and re-emits it as a properly sequenced SSE event stream,
 *     satisfying the OpenAI SDK without any client-side changes.
 *
 *  3. Parameter sanitisation  – gpt-5 / o-series models reject sampling
 *     parameters such as temperature ≠ 1.  The Worker strips them
 *     automatically so clients never see a 400 error.
 *
 * Endpoints
 * ─────────
 *  POST /v1/chat/completions   Direct proxy to Azure Chat Completions
 *  POST /v1/responses          OpenAI Responses API → Chat Completions adapter
 *  GET  /v1/models             Static model list (returns the configured deployment)
 *  GET  /v1/balance            Proxy to the upstream balance endpoint
 *  GET  /health                Service info / liveness check
 */

// ---------------------------------------------------------------------------
// Environment / configuration
// ---------------------------------------------------------------------------

export interface Env {
  /** Base URL of the Azure OpenAI gateway, e.g. https://your-tenant.azure-api.net */
  AZURE_UPSTREAM_HOST?: string;
  /** Azure deployment name, e.g. gpt-4o-mini */
  AZURE_DEPLOYMENT?: string;
  /** Azure api-version query parameter */
  AZURE_API_VERSION?: string;
  /**
   * Azure API key.
   * Use `wrangler secret put AZURE_API_KEY` in production – never hard-code this.
   */
  AZURE_API_KEY?: string;
}

interface Config {
  upstreamHost: string;
  deployment: string;
  apiVersion: string;
  apiKey: string | undefined;
}

function getConfig(env: Env): Config {
  return {
    upstreamHost: (env.AZURE_UPSTREAM_HOST ?? "https://hkust.azure-api.net").replace(/\/+$/, ""),
    deployment:   (env.AZURE_DEPLOYMENT   ?? "gpt-4o-mini").replace(/^\/+|\/+$/g, ""),
    apiVersion:    env.AZURE_API_VERSION  ?? "2025-02-01-preview",
    apiKey:        env.AZURE_API_KEY?.trim(),
  };
}

/** Build the full Azure Chat Completions URL including the required api-version. */
function chatUrl({ upstreamHost, deployment, apiVersion }: Config): string {
  return `${upstreamHost}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown>;

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function apiError(message: string, status = 400, type = "invalid_request_error"): Response {
  return jsonResponse({ error: { message, type, param: null, code: null } }, { status });
}

/**
 * Build headers for the upstream Azure request.
 *
 * - Strips hop-by-hop and Cloudflare-injected headers that must not be
 *   forwarded (host, cf-ray, x-forwarded-for, …).
 * - Replaces the client's `Authorization: Bearer …` with Azure's `api-key`.
 */
function buildUpstreamHeaders(incoming: Request, apiKey: string): Headers {
  const headers = new Headers(incoming.headers);
  for (const name of [
    "host", "content-length", "connection", "accept-encoding",
    "authorization",          // Azure uses api-key, not Bearer tokens
    "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
    "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
  ]) {
    headers.delete(name);
  }
  headers.set("api-key", apiKey);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  return headers;
}

// ---------------------------------------------------------------------------
// Parameter sanitisation
// ---------------------------------------------------------------------------

const REASONING_MODEL_PREFIXES = ["gpt-5", "o1", "o3"];
const UNSUPPORTED_SAMPLING_PARAMS = [
  "temperature", "top_p", "presence_penalty", "frequency_penalty",
] as const;

/**
 * Azure's gpt-5 / o-series reasoning models reject sampling parameters
 * (temperature, top_p, etc.) unless temperature is exactly 1.
 * Strip them silently so callers don't need to special-case these models.
 */
function sanitizeBody(body: AnyObj): AnyObj {
  const model = typeof body.model === "string" ? body.model : "";
  if (!REASONING_MODEL_PREFIXES.some((p) => model.startsWith(p))) return body;

  const sanitized = { ...body };
  for (const param of UNSUPPORTED_SAMPLING_PARAMS) delete sanitized[param];
  return sanitized;
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions  –  direct proxy
// ---------------------------------------------------------------------------

/**
 * Forward a standard Chat Completions request to Azure.
 * Streaming is forced off because the Azure endpoint does not support SSE.
 * Unsupported sampling parameters are stripped automatically.
 */
async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  if (!cfg.apiKey) return apiError("AZURE_API_KEY is not configured.", 500, "server_error");

  let bodyText: string;
  try   { bodyText = await request.text(); }
  catch { return apiError("Unable to read request body."); }
  if (!bodyText) return apiError("Request body is required.");

  let body: string;
  try {
    const parsed = JSON.parse(bodyText) as AnyObj;
    parsed.stream = false; // Azure does not support streaming
    body = JSON.stringify(sanitizeBody(parsed));
  } catch {
    body = bodyText;       // not valid JSON – pass through and let Azure reject it
  }

  let upstream: Response;
  try {
    upstream = await fetch(new Request(chatUrl(cfg), {
      method: "POST",
      headers: buildUpstreamHeaders(request, cfg.apiKey),
      body,
    }));
  } catch (err) {
    console.error("[chat] upstream fetch failed:", err);
    return apiError("Upstream request failed.", 502, "server_error");
  }

  const headers = new Headers(upstream.headers);
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/responses  –  OpenAI Responses API adapter
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAI Responses API request body into a Chat Completions body.
 *
 * Key differences handled:
 *  • `input` (string | array)  →  `messages` array
 *  • `instructions`            →  system message prepended to `messages`
 *  • `function_call_output`    →  role:"tool" message
 *  • `function_call`           →  assistant message with tool_calls
 *  • content arrays            →  concatenated text strings
 *  • tools schema shape        →  { name, … }  →  { function: { name, … } }
 *  • `max_output_tokens`       →  `max_tokens`
 *  • `stream` forced to false  –  fake streaming is applied after the response
 */
function responsesToChat(body: AnyObj): AnyObj {
  const messages: AnyObj[] = [];

  // System prompt from instructions field
  if (typeof body.instructions === "string" && body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }

  // Convert input → messages
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    // Consecutive function_call items must be merged into one assistant message
    // with multiple tool_calls.  Azure requires that every tool_call_id in an
    // assistant message is immediately followed by its tool result.
    let pendingToolCalls: AnyObj[] = [];

    const flushToolCalls = () => {
      if (pendingToolCalls.length === 0) return;
      messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
      pendingToolCalls = [];
    };

    for (const item of input as AnyObj[]) {
      const t = item.type as string | undefined;

      if (t === "function_call") {
        // Accumulate tool calls – they will be flushed as one assistant message
        pendingToolCalls.push({
          id: item.call_id ?? item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        });
      } else if (t === "function_call_output") {
        // Flush any pending tool calls before adding the result
        flushToolCalls();
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        });
      } else if (typeof item.role === "string") {
        // Regular user / assistant / system message
        flushToolCalls();
        let content = item.content;
        if (Array.isArray(content)) {
          const texts = (content as AnyObj[])
            .filter((c) => c.type === "text" || c.type === "input_text" || c.type === "output_text")
            .map((c) => c.text as string);
          content = texts.length ? texts.join("") : JSON.stringify(content);
        }
        messages.push({ role: item.role, content });
      }
    }

    flushToolCalls(); // flush any trailing tool calls
  }

  // Responses API tool shape  →  Chat Completions tool shape
  // Responses: { type:"function", name, description, parameters }
  // Chat:      { type:"function", function:{ name, description, parameters } }
  let tools: unknown[] | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    tools = (body.tools as AnyObj[]).map((t) =>
      t.type === "function"
        ? { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }
        : t
    );
  }

  const out: AnyObj = { model: body.model, messages };
  if (typeof body.max_output_tokens === "number") out.max_tokens = body.max_output_tokens;
  if (typeof body.temperature        === "number") out.temperature = body.temperature;
  if (typeof body.top_p              === "number") out.top_p = body.top_p;
  if (tools) out.tools = tools;
  out.stream = false; // always non-streaming toward Azure; fake SSE is added below
  return out;
}

/**
 * Convert an Azure Chat Completions response body into OpenAI Responses API format.
 *
 * Handles two output shapes:
 *  • Text reply   →  output[].type = "message"
 *  • Tool call(s) →  output[].type = "function_call"
 */
function chatToResponses(chat: AnyObj): AnyObj {
  const choice  = (chat.choices as AnyObj[] | undefined)?.[0] as AnyObj | undefined;
  const message = choice?.message as AnyObj | undefined;
  const output: AnyObj[] = [];

  if (message) {
    const toolCalls = message.tool_calls as AnyObj[] | undefined;
    if (toolCalls?.length) {
      // Model wants to call one or more tools
      for (const tc of toolCalls) {
        const fn = tc.function as AnyObj;
        output.push({
          type: "function_call",
          id: tc.id, call_id: tc.id,
          name: fn.name, arguments: fn.arguments,
        });
      }
    } else if (message.content) {
      // Plain text reply
      output.push({
        type: "message",
        id: `msg_${chat.id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: message.content, annotations: [] }],
      });
    }
  }

  const usage = chat.usage as AnyObj | undefined;
  const pd    = usage?.prompt_tokens_details     as AnyObj | undefined;
  const cd    = usage?.completion_tokens_details as AnyObj | undefined;

  return {
    id: `resp_${chat.id}`,
    object: "response",
    created_at: chat.created,
    model: chat.model,
    status: "completed",
    output,
    // Fields required by the OpenAI SDK response schema
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    temperature: 1,
    top_p: 1,
    truncation: "disabled",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    usage: usage ? {
      input_tokens:  usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens:  usage.total_tokens,
      input_tokens_details:  { cached_tokens:    pd?.cached_tokens    ?? 0 },
      output_tokens_details: { reasoning_tokens: cd?.reasoning_tokens ?? 0 },
    } : undefined,
  };
}

/**
 * Fake streaming response.
 *
 * The OpenAI SDK always sends stream=true for the Responses API, but Azure
 * does not support SSE.  This function takes a completed Responses API object
 * and re-emits it as a correctly-sequenced SSE event stream so the SDK parses
 * it without errors.
 *
 * Flow: Azure (non-stream JSON) → chatToResponses → fakeStreamingResponse → SSE
 *
 * Event sequences emitted:
 *   Text reply:  created → output_item.added → content_part.added →
 *                output_text.delta → output_text.done → content_part.done →
 *                output_item.done → completed → [DONE]
 *
 *   Tool call:   created → output_item.added → function_call_arguments.delta →
 *                function_call_arguments.done → output_item.done → completed → [DONE]
 */
function fakeStreamingResponse(resp: AnyObj): Response {
  const enc = new TextEncoder();
  const sse = (event: string, data: unknown) =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const chunks: Uint8Array[] = [];
  const output = (resp.output as AnyObj[] | undefined) ?? [];

  chunks.push(sse("response.created", {
    type: "response.created",
    response: { ...resp, status: "in_progress", output: [] },
  }));

  output.forEach((item, outputIndex) => {
    if (item.type === "message") {
      chunks.push(sse("response.output_item.added", {
        type: "response.output_item.added", output_index: outputIndex,
        item: { ...item, status: "in_progress", content: [] },
      }));

      ((item.content as AnyObj[] | undefined) ?? []).forEach((part, contentIndex) => {
        const text = (part.text as string) ?? "";
        chunks.push(sse("response.content_part.added",  { type: "response.content_part.added",  output_index: outputIndex, content_index: contentIndex, part: { type: "output_text", text: "" } }));
        chunks.push(sse("response.output_text.delta",   { type: "response.output_text.delta",   output_index: outputIndex, content_index: contentIndex, delta: text }));
        chunks.push(sse("response.output_text.done",    { type: "response.output_text.done",    output_index: outputIndex, content_index: contentIndex, text }));
        chunks.push(sse("response.content_part.done",   { type: "response.content_part.done",   output_index: outputIndex, content_index: contentIndex, part: { ...part } }));
      });

      chunks.push(sse("response.output_item.done", {
        type: "response.output_item.done", output_index: outputIndex,
        item: { ...item, status: "completed" },
      }));

    } else if (item.type === "function_call") {
      const args = (item.arguments as string) ?? "";
      chunks.push(sse("response.output_item.added",            { type: "response.output_item.added",            output_index: outputIndex, item: { ...item, arguments: "", status: "in_progress" } }));
      chunks.push(sse("response.function_call_arguments.delta",{ type: "response.function_call_arguments.delta",output_index: outputIndex, delta: args }));
      chunks.push(sse("response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: outputIndex, arguments: args }));
      chunks.push(sse("response.output_item.done",             { type: "response.output_item.done",             output_index: outputIndex, item: { ...item, status: "completed" } }));
    }
  });

  chunks.push(sse("response.completed", { type: "response.completed", response: resp }));
  chunks.push(enc.encode("data: [DONE]\n\n"));

  return new Response(
    new ReadableStream({ start(ctrl) { for (const c of chunks) ctrl.enqueue(c); ctrl.close(); } }),
    { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
  );
}

async function handleResponses(request: Request, env: Env): Promise<Response> {
  const cfg = getConfig(env);
  if (!cfg.apiKey) return apiError("AZURE_API_KEY is not configured.", 500, "server_error");

  let body: AnyObj;
  try   { body = await request.json() as AnyObj; }
  catch { return apiError("Invalid JSON body."); }

  const isStreaming = body.stream === true;

  // Step 1 – translate Responses API → Chat Completions, fetch from Azure
  const chatBody = JSON.stringify(sanitizeBody(responsesToChat(body)));
  let upstream: Response;
  try {
    upstream = await fetch(new Request(chatUrl(cfg), {
      method: "POST",
      headers: buildUpstreamHeaders(request, cfg.apiKey),
      body: chatBody,
    }));
  } catch (err) {
    console.error("[responses] upstream fetch failed:", err);
    return apiError("Upstream request failed.", 502, "server_error");
  }

  if (upstream.status >= 400) {
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { "content-type": "application/json" } });
  }

  // Step 2 – convert the Azure response back to Responses API format
  let chatJson: AnyObj;
  try   { chatJson = await upstream.json() as AnyObj; }
  catch { return apiError("Failed to parse upstream response.", 502, "server_error"); }

  const responsesJson = chatToResponses(chatJson);

  // Step 3 – if the client wanted streaming, emit a fake SSE sequence
  return isStreaming ? fakeStreamingResponse(responsesJson) : jsonResponse(responsesJson);
}

// ---------------------------------------------------------------------------
// GET /v1/balance  –  upstream balance proxy
// ---------------------------------------------------------------------------

/**
 * Proxy the upstream balance endpoint.
 * Useful for monitoring remaining quota without exposing the API key to clients.
 */
async function handleBalance(env: Env): Promise<Response> {
  const cfg = getConfig(env);
  if (!cfg.apiKey) return apiError("AZURE_API_KEY is not configured.", 500, "server_error");

  try {
    const resp = await fetch(`${cfg.upstreamHost}/openai-balance/get`, {
      headers: { "api-key": cfg.apiKey, "accept": "application/json" },
    });
    return new Response(await resp.text(), {
      status: resp.status,
      headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    console.error("[balance] upstream fetch failed:", err);
    return apiError("Failed to fetch balance.", 502, "server_error");
  }
}

// ---------------------------------------------------------------------------
// GET /v1/models  –  static model stub
// ---------------------------------------------------------------------------

/**
 * Return the configured deployment as a single-entry model list.
 * Required by some OpenAI-compatible clients that call /v1/models on startup.
 */
function handleModels(env: Env): Response {
  const { deployment } = getConfig(env);
  return jsonResponse({
    object: "list",
    data: [{ id: deployment, object: "model", created: 1677610602, owned_by: "azure" }],
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization, api-key",
        },
      });
    }

    // Liveness / info
    if (pathname === "/" || pathname === "/health") {
      const { upstreamHost, deployment, apiVersion } = getConfig(env);
      return jsonResponse({
        status: "ok",
        upstream: { host: upstreamHost, deployment, api_version: apiVersion },
        routes: ["/v1/chat/completions", "/v1/responses", "/v1/models", "/v1/balance"],
      });
    }

    if (pathname === "/v1/models")           return handleModels(env);
    if (pathname === "/v1/balance")          return handleBalance(env);
    if (pathname === "/v1/responses")        return method === "POST" ? handleResponses(request, env)       : apiError("Method not allowed.", 405);
    if (pathname === "/v1/chat/completions") return method === "POST" ? handleChatCompletions(request, env) : apiError("Method not allowed.", 405);

    return apiError("Not found.", 404, "not_found");
  },
};
