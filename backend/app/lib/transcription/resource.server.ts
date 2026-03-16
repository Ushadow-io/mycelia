import { z } from "zod";
import { Buffer } from "node:buffer";
import { Resource } from "@/lib/auth/resources.ts";
import { Auth } from "@/lib/auth/core.server.ts";
import { tracer } from "@/lib/telemetry.ts";
import { getServerConfig } from "@/lib/config/serverConfig.server.ts";

const transcriptionRequestSchema = z.object({
  action: z.literal("transcribe"),
  file: z.any(),
  fileName: z.string().optional(),
  fileType: z.string().optional(),
  language: z.string().optional(),
  prompt: z.string().optional(),
});

type TranscriptionRequest = z.infer<typeof transcriptionRequestSchema>;
type TranscriptionResponse = any | Response;

export class TranscriptionResource implements Resource<TranscriptionRequest, TranscriptionResponse> {
  code = "transcription";
  description = "Audio transcription";
  schemas: {
    request: z.ZodType<TranscriptionRequest>;
    response: z.ZodType<TranscriptionResponse>;
  } = {
    request: transcriptionRequestSchema as z.ZodType<TranscriptionRequest>,
    response: z.any() as z.ZodType<TranscriptionResponse>,
  };

  async getInferenceProvider(): Promise<{ baseUrl: string; apiKey: string; model?: string } | null> {
    // Stateless config: read from env vars first (ushadow pattern)
    const envBaseUrl = Deno.env.get("TRANSCRIPTION_BASE_URL") || Deno.env.get("WHISPER_BASE_URL");
    const envApiKey = Deno.env.get("TRANSCRIPTION_API_KEY") || Deno.env.get("WHISPER_API_KEY");
    const envModel = Deno.env.get("TRANSCRIPTION_MODEL") || Deno.env.get("WHISPER_MODEL");

    if (envBaseUrl) {
      return {
        baseUrl: envBaseUrl,
        apiKey: envApiKey || "", // Allow empty API key for local services
        model: envModel,
      };
    }

    // Fallback to MongoDB config for backward compatibility
    const config = await getServerConfig();
    const providerConfig = config.transcription ?? config.inference;

    if (!providerConfig?.baseUrl) {
      return null;
    }

    // Allow empty API key for local services (like Faster Whisper)
    return {
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey || "",
      model: providerConfig.model,
    };
  }

  async use(input: TranscriptionRequest, auth: Auth): Promise<TranscriptionResponse> {
    const startTime = performance.now();
    const span = tracer.startSpan("transcription_resource_use", {
      attributes: {
        "transcription.action": input.action,
      },
    });

    try {
      switch (input.action) {
        case "transcribe": {
          const provider = await this.getInferenceProvider();
          if (!provider) {
            span.setStatus({
              code: 2,
              message: "Transcription provider not configured",
            });
            throw new Error(
              "Transcription provider not configured. Please configure transcription.baseUrl in server settings (e.g., http://faster-whisper:8000 for local Whisper)."
            );
          }

          // Normalize base URL: remove trailing slash, ensure we don't duplicate /v1
          let baseUrl = provider.baseUrl.replace(/\/$/, "");
          // If baseUrl already ends with /v1, don't add it again
          const transcriptionPath = baseUrl.endsWith("/v1")
            ? "/audio/transcriptions"
            : "/v1/audio/transcriptions";
          const fullUrl = baseUrl + transcriptionPath;

          span.setAttributes({
            "transcription.provider_url": provider.baseUrl,
            "transcription.full_url": fullUrl,
            "transcription.has_api_key": !!provider.apiKey,
          });

          // Debug: Log file type info
          console.log("[TranscriptionResource] File type check:", {
            type: typeof input.file,
            isUint8Array: input.file instanceof Uint8Array,
            isBuffer: input.file instanceof Buffer,
            hasBinaryField: input.file && typeof input.file === "object" && "$binary" in input.file,
            keys: input.file && typeof input.file === "object" ? Object.keys(input.file) : [],
          });

          let fileBuffer: Uint8Array;
          if (input.file instanceof Uint8Array) {
            fileBuffer = input.file;
          } else if (input.file instanceof Buffer ) {
            fileBuffer = new Uint8Array(input.file);
          } else if (input.file?.buffer instanceof Uint8Array) {
            fileBuffer = new Uint8Array(input.file.buffer);
          } else if (input.file && typeof input.file === "object" && "$binary" in input.file) {
            const binary = (input.file as { $binary: { base64: string; subType?: string } }).$binary;
            const decoded = Buffer.from(binary.base64, "base64");
            fileBuffer = new Uint8Array(decoded);
          } else {
            throw new Error(`Invalid file format. Expected Uint8Array, Buffer, or EJSON binary. Got ${typeof input.file}, ${Object.keys(input.file)}`);
          }

          console.log("[TranscriptionResource] File buffer size:", fileBuffer.length);

          const formData = new FormData();
          const newBuffer = new Uint8Array(fileBuffer);
          const blob = new Blob([newBuffer], { type: input.fileType || "audio/mpeg" });
          const fileName = input.fileName || "audio.mp3";
          const file = new File([blob], fileName, { type: input.fileType || "audio/mpeg" });
          formData.append("file", file);

          // Only add language if specified and not "auto" (Whisper auto-detects when omitted)
          if (input.language && input.language !== "auto") {
            formData.append("language", input.language);
          }

          if (input.prompt) {
            formData.append("prompt", input.prompt);
          }

          // Use configured model if available, otherwise omit (server will use default)
          // For Faster Whisper: expects "base", "small", "medium", etc.
          // For OpenAI: expects "whisper-1"
          if (provider.model) {
            formData.append("model", provider.model);
          }

          // Request verbose_json format to get segments with timestamps
          // Default format only returns text without segments
          formData.append("response_format", "verbose_json");

          // Build headers - only add Authorization if API key is present
          const headers: Record<string, string> = {};
          if (provider.apiKey) {
            headers["Authorization"] = `Bearer ${provider.apiKey}`;
          }

          const proxyResponse = await fetch(
            fullUrl,
            {
              method: "POST",
              headers,
              body: formData,
            },
          );

          span.setAttributes({
            "transcription.response_status": proxyResponse.status,
            "transcription.response_ok": proxyResponse.ok,
          });

          if (!proxyResponse.ok) {
            const errorBody = await proxyResponse.text();
            span.setStatus({
              code: 2,
              message: `API error: ${proxyResponse.status}`,
            });
            throw new Error(`Failed to transcribe: ${errorBody}`);
          }

          const responseText = await proxyResponse.text();
          console.log("[TranscriptionResource] Response text preview:", responseText.substring(0, 500));

          try {
            const jsonResponse = JSON.parse(responseText);
            console.log("[TranscriptionResource] Parsed response:", {
              hasText: !!jsonResponse.text,
              textLength: jsonResponse.text?.length,
              hasSegments: !!jsonResponse.segments,
              segmentCount: jsonResponse.segments?.length,
            });
            span.setStatus({ code: 1 });
            return jsonResponse;
          } catch (parseError) {
            const errorMessage = parseError instanceof Error
              ? parseError.message
              : "Unknown parse error";
            span.setStatus({
              code: 2,
              message: `JSON parse error: ${errorMessage}`,
            });
            throw new Error(
              `Invalid JSON response from provider: ${errorMessage}`,
            );
          }
          break;
        }
        default: {
          span.setStatus({ code: 2, message: "Unknown action" });
          throw new Error("Unknown action");
        }
      }
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      const duration = (performance.now() - startTime) / 1000;
      span.setAttributes({ "transcription.duration_seconds": duration });
      span.end();
    }
  }

  extractActions(input: TranscriptionRequest) {
    return [{
      path: ["transcription", "audio"],
      actions: [input.action],
    }];
  }
}

export async function getTranscriptionResource(
  auth: Auth,
): Promise<(input: TranscriptionRequest) => Promise<TranscriptionResponse>> {
  return auth.getResource("transcription");
}

