/**
 * ConversationService - Business logic for conversations
 *
 * Transforms mycelia conversation data to API format.
 * Handles business rules, validation, and data transformation.
 */

import type { Auth } from "@/lib/auth/core.server.ts";
import {
  ConversationStore,
  type ConversationDocument,
  type ConversationFilters,
} from "@/lib/conversations/store.server.ts";

/**
 * API conversation format (DTO)
 * Standard structure for conversation responses
 */
export interface ConversationDTO {
  conversation_id: string;
  audio_uuid?: string;
  user_id: string;
  client_id?: string;
  audio_path?: string;
  cropped_audio_path?: string;
  created_at: string;
  started_at?: string;
  deleted: boolean;
  deletion_reason: string | null;
  deleted_at: string | null;
  title: string;
  summary?: string;
  detailed_summary?: string;
  active_transcript_version?: string;
  active_memory_version?: string;
  segment_count?: number;
  has_memory?: boolean;
  memory_count?: number;
  transcript_version_count?: number;
  memory_version_count?: number;
}

export class ConversationService {
  /**
   * Get recent conversations in API format
   */
  static async getRecentConversations(
    auth: Auth,
    options: {
      limit?: number;
      skip?: number;
      startDate?: Date;
      endDate?: Date;
    } = {}
  ): Promise<ConversationDTO[]> {
    // Validate limit (max 100 to prevent abuse)
    const limit = Math.min(options.limit || 25, 100);

    const filters: ConversationFilters = {
      limit,
      skip: options.skip || 0,
      startDate: options.startDate,
      endDate: options.endDate,
    };

    const conversations = await ConversationStore.findRecent(auth, filters);

    return conversations.map((conv) =>
      this.toApiFormat(conv, auth)
    );
  }

  /**
   * Get conversations for specific audio chunks
   * Used by the pipeline API
   */
  static async getConversationsForChunks(
    auth: Auth,
    chunkIds: string[]
  ): Promise<ConversationDocument[]> {
    if (chunkIds.length === 0) {
      return [];
    }

    return await ConversationStore.findRecent(auth, { chunkIds });
  }

  /**
   * Get a single conversation by ID
   * Includes transcript segments from transcriptions collection
   */
  static async getConversationById(
    auth: Auth,
    conversationId: string
  ): Promise<ConversationDTO | null> {
    const conversation = await ConversationStore.findById(auth, conversationId);

    if (!conversation) {
      return null;
    }

    const result = this.toApiFormat(conversation, auth);

    // Fetch transcripts from transcriptions collection if available
    const chunkId = conversation.metadata?.extractedWith?.chunkId;
    if (chunkId) {
      try {
        const { getRootDB } = await import("@/lib/mongo/core.server.ts");
        const db = await getRootDB();
        const { ObjectId } = await import("mongodb");

        // First, get the conversation_chunk to find all transcription IDs
        const conversationChunk = await db.collection("conversation_chunks").findOne({
          _id: new ObjectId(chunkId),
        });

        // Get conversation start time from timeRanges
        const conversationStart = conversation.timeRanges?.[0]?.start;

        if (conversationChunk && conversationChunk.transcriptionIds) {
          // Query all transcriptions for this chunk, sorted by start time
          const transcriptions = await db
            .collection("transcriptions")
            .find({
              _id: { $in: conversationChunk.transcriptionIds.map((id: any) => new ObjectId(id)) },
            })
            .sort({ start: 1 }) // Sort by start time, not createdAt
            .toArray();

          if (transcriptions && transcriptions.length > 0) {
            // Aggregate all transcript texts
            const fullTranscript = transcriptions
              .map((t: any) => t.text || "")
              .filter((text) => text.length > 0)
              .join("\n\n");

            (result as any).transcript = fullTranscript;

            // Collect all segments with their transcription index (for preferring later ones)
            const allSegmentsWithIndex: Array<{
              segment: any;
              transcriptionIdx: number;
            }> = [];

            transcriptions.forEach((transcription: any, transcriptionIdx: number) => {
              if (transcription.segments && Array.isArray(transcription.segments)) {
                // Each transcription has its own start time
                const transcriptionStart = transcription.start
                  ? new Date(transcription.start).getTime()
                  : null;

                // Calculate time offset in seconds from conversation start
                let timeOffset = 0;
                if (transcriptionStart && conversationStart) {
                  const conversationStartMs = new Date(conversationStart).getTime();
                  timeOffset = (transcriptionStart - conversationStartMs) / 1000;
                }

                transcription.segments.forEach((seg: any) => {
                  const adjustedSeg = {
                    ...seg,
                    start: (seg.start || 0) + timeOffset,
                    end: (seg.end || 0) + timeOffset,
                  };
                  allSegmentsWithIndex.push({
                    segment: adjustedSeg,
                    transcriptionIdx,
                  });
                });
              }
            });

            // Deduplicate: when segments overlap, keep the one from the LATER transcription
            const dedupedSegments: any[] = [];
            const sortedByTime = allSegmentsWithIndex.sort(
              (a, b) => a.segment.start - b.segment.start
            );

            for (const item of sortedByTime) {
              // Check if this segment overlaps with any segment from a later transcription
              const laterOverlaps = sortedByTime.filter((other) => {
                if (other.transcriptionIdx <= item.transcriptionIdx) return false;

                // Check for overlap (>25% of segment duration OR any overlap >2 seconds)
                const overlapStart = Math.max(item.segment.start, other.segment.start);
                const overlapEnd = Math.min(item.segment.end, other.segment.end);
                const overlap = Math.max(0, overlapEnd - overlapStart);
                const itemDuration = item.segment.end - item.segment.start;
                const overlapPercent = overlap / itemDuration;

                return overlap > 2 || overlapPercent > 0.25;
              });

              if (laterOverlaps.length === 0) {
                dedupedSegments.push(item.segment);
              }
            }

            const allSegments = dedupedSegments.sort((a, b) => a.start - b.start);

            // Transform segments to API format (add speaker field)
            if (allSegments.length > 0) {
              (result as any).segments = allSegments.map(
                (seg: any, idx: number) => ({
                  text: seg.text || "",
                  speaker: `Speaker ${idx % 2}`, // Simple alternating speakers for now
                  start: seg.start,
                  end: seg.end,
                  confidence: seg.avg_logprob
                    ? Math.exp(seg.avg_logprob)
                    : undefined,
                })
              );
            }
          }
        }
      } catch (error) {
        console.warn(
          `[ConversationService] Failed to fetch transcriptions for chunk ${chunkId}:`,
          error
        );
      }
    }

    return result;
  }

  /**
   * Transform mycelia conversation to API format
   */
  private static toApiFormat(
    conv: ConversationDocument,
    auth: Auth
  ): ConversationDTO {
    // Extract time range (use first time range if multiple exist)
    const primaryTimeRange = conv.timeRanges?.[0];

    // Get user ID from auth context
    const userId = auth.userId || "unknown";

    // Extract metadata
    const chunkId = conv.metadata?.extractedWith?.chunkId;
    const segmentCount = conv.metadata?.transcription?.segmentCount ?? 0;
    const hasMemory = conv.metadata?.transcription?.hasMemory ?? false;
    const memoryCount = conv.metadata?.transcription?.memoryCount ?? 0;

    // Calculate duration from timeRanges if available
    let durationSeconds: number | undefined;
    if (primaryTimeRange?.start && primaryTimeRange?.end) {
      const start = new Date(primaryTimeRange.start).getTime();
      const end = new Date(primaryTimeRange.end).getTime();
      durationSeconds = Math.floor((end - start) / 1000);
    }

    return {
      // Core IDs
      conversation_id: conv._id.toString(),
      audio_uuid: chunkId, // Use chunk ID as audio UUID
      user_id: userId,
      client_id: chunkId ? `mycelia-${chunkId.slice(0, 8)}` : undefined,

      // Audio paths (mycelia may not have these)
      audio_path: undefined,
      cropped_audio_path: undefined,

      // Timestamps
      created_at: conv.createdAt.toISOString(),
      started_at: primaryTimeRange?.start
        ? new Date(primaryTimeRange.start).toISOString()
        : undefined,
      completed_at: primaryTimeRange?.end
        ? new Date(primaryTimeRange.end).toISOString()
        : undefined,
      deleted: false,
      deletion_reason: null,
      deleted_at: null,

      // Content
      title: conv.name,
      summary: this.generateSummary(conv),
      detailed_summary: this.generateDetailedSummary(conv),

      // Duration
      duration_seconds: durationSeconds,

      // Versions (mycelia uses version field differently)
      active_transcript_version: undefined,
      active_memory_version: undefined,

      // Stats
      segment_count: segmentCount,
      has_memory: hasMemory,
      memory_count: memoryCount,
      transcript_version_count: 1,
      memory_version_count: hasMemory ? 1 : 0,

      // Mycelia-specific fields (preserve for frontend)
      timeRanges: conv.timeRanges,
      summaries: conv.summaries,
      details: conv.details,
      name: conv.name,
    } as any;
  }

  /**
   * Generate a brief summary from conversation name and details
   * API format includes both summary and detailed_summary
   */
  private static generateSummary(conv: ConversationDocument): string {
    // Try summaries array first (most common)
    if (conv.summaries && conv.summaries.length > 0) {
      const summaryText = conv.summaries[0].text;
      // If summary is long, truncate to first sentence
      if (summaryText.length > 200) {
        const firstSentence = summaryText.split(".")[0];
        return firstSentence.length > 200
          ? firstSentence.substring(0, 197) + "..."
          : firstSentence + ".";
      }
      return summaryText;
    }

    // If details exist, create a brief summary
    if (conv.details) {
      const firstSentence = conv.details.split(".")[0];
      return firstSentence.length > 200
        ? firstSentence.substring(0, 197) + "..."
        : firstSentence + ".";
    }

    // Fall back to the name
    return conv.name;
  }

  /**
   * Generate detailed summary (full text)
   */
  private static generateDetailedSummary(
    conv: ConversationDocument
  ): string | undefined {
    // Return full summary text if available
    if (conv.summaries && conv.summaries.length > 0) {
      return conv.summaries[0].text;
    }

    // Fall back to details
    return conv.details || undefined;
  }

  /**
   * Get conversation statistics
   */
  static async getStats(auth: Auth): Promise<{
    total_conversations: number;
    conversations_with_memory: number;
  }> {
    const totalCount = await ConversationStore.count(auth);

    // TODO: Add a count query for conversations with memory
    // For now, return total as placeholder
    return {
      total_conversations: totalCount,
      conversations_with_memory: 0, // Would need additional query
    };
  }
}
