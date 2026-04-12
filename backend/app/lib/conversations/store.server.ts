/**
 * ConversationStore - Data access layer for conversations
 *
 * Encapsulates all MongoDB queries for conversation objects.
 * This layer has NO business logic - just database operations.
 */

import type { Auth } from "@/lib/auth/core.server.ts";
import { getRootDB } from "@/lib/mongo/core.server.ts";
import type { ObjectId } from "mongodb";

export interface ConversationDocument {
  _id: ObjectId;
  name: string;
  details?: string;
  icon?: { text?: string; base64?: string };
  isConversation: boolean;
  timeRanges?: Array<{ start: Date; end: Date; name?: string }>;
  metadata?: {
    extractedWith?: {
      chunkId?: string;
      sequenceId?: string;
    };
    transcription?: {
      segmentCount?: number;
      hasMemory?: boolean;
      memoryCount?: number;
    };
  };
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ConversationFilters {
  /** Limit number of results */
  limit?: number;
  /** Skip for pagination */
  skip?: number;
  /** Filter by chunk IDs */
  chunkIds?: string[];
  /** Filter by start date */
  startDate?: Date;
  /** Filter by end date */
  endDate?: Date;
}

export class ConversationStore {
  /**
   * Find recent conversations with optional filters
   */
  static async findRecent(
    auth: Auth,
    filters: ConversationFilters = {}
  ): Promise<ConversationDocument[]> {
    const { limit = 25, skip = 0, chunkIds, startDate, endDate } = filters;

    const db = await getRootDB();
    const query: any = { isConversation: true };

    // Filter by chunk IDs if provided
    if (chunkIds && chunkIds.length > 0) {
      query["metadata.extractedWith.chunkId"] = { $in: chunkIds };
    }

    // Filter by date range if provided
    if (startDate || endDate) {
      query["timeRanges.start"] = {};
      if (startDate) query["timeRanges.start"].$gte = startDate;
      if (endDate) query["timeRanges.start"].$lte = endDate;
    }

    const conversations = await db
      .collection("objects")
      .find(query)
      .sort({ updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return conversations as ConversationDocument[];
  }

  /**
   * Find conversations with full relationship data (subject/object joins)
   *
   * This uses aggregation pipeline to join related objects.
   * Used when you need the full relationship context.
   */
  static async findWithRelationships(
    auth: Auth,
    filters: ConversationFilters = {}
  ): Promise<any[]> {
    const { limit = 25, skip = 0 } = filters;

    const db = await getRootDB();

    const pipeline = [
      { $match: { isConversation: true } },
      // Join subject object
      {
        $lookup: {
          from: "objects",
          localField: "relationship.subject",
          foreignField: "_id",
          as: "subjectObject",
        },
      },
      // Join object object
      {
        $lookup: {
          from: "objects",
          localField: "relationship.object",
          foreignField: "_id",
          as: "objectObject",
        },
      },
      // Unwind arrays (preserving null values)
      {
        $unwind: {
          path: "$subjectObject",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $unwind: {
          path: "$objectObject",
          preserveNullAndEmptyArrays: true,
        },
      },
      { $sort: { updatedAt: -1, _id: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];

    const conversations = await db
      .collection("objects")
      .aggregate(pipeline)
      .toArray();

    return conversations;
  }

  /**
   * Get a single conversation by ID
   */
  static async findById(
    auth: Auth,
    conversationId: string
  ): Promise<ConversationDocument | null> {
    const db = await getRootDB();
    const { ObjectId } = await import("mongodb");

    if (!ObjectId.isValid(conversationId)) {
      return null;
    }

    const conversation = await db
      .collection("objects")
      .findOne({
        _id: new ObjectId(conversationId),
        isConversation: true
      });

    return conversation as ConversationDocument | null;
  }

  /**
   * Count total conversations
   */
  static async count(auth: Auth): Promise<number> {
    const db = await getRootDB();
    return await db
      .collection("objects")
      .countDocuments({ isConversation: true });
  }
}
