/**
 * Conversations Router - Thin HTTP adapter
 *
 * Provides mycelia conversation endpoints.
 * Follows architecture rule: max 30 lines per endpoint.
 */

import type { Request, Response } from "express";
import { authenticateOr401 } from "../lib/auth/core.server.ts";
import { ConversationService } from "../services/conversation.server.ts";

/**
 * GET /data/conversations
 * Returns recent conversations in API format
 *
 * Query params:
 *   - limit: max results (default 25, max 100)
 *   - skip: pagination offset (default 0)
 *   - start: filter by start date (ISO 8601)
 *   - end: filter by end date (ISO 8601)
 */
export async function dataConversationsHandler(req: Request, res: Response) {
  try {
    const auth = await authenticateOr401(req, res);

    // Parse query params
    const limit = parseInt(req.query.limit as string) || 25;
    const skip = parseInt(req.query.skip as string) || 0;
    const startDate = req.query.start
      ? new Date(req.query.start as string)
      : undefined;
    const endDate = req.query.end
      ? new Date(req.query.end as string)
      : undefined;

    // Get conversations via service
    const conversations = await ConversationService.getRecentConversations(
      auth,
      { limit, skip, startDate, endDate }
    );

    res.json({
      conversations,
      count: conversations.length,
      limit,
      skip,
    });
  } catch (error) {
    if (error instanceof globalThis.Response) {
      const status = error.status;
      const body = await error.json().catch(() => ({}));
      res.status(status === 403 ? 401 : status).json(body);
      return;
    }
    console.error("Error in /data/conversations:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /data/conversations/:id
 * Returns a single conversation by ID in API format
 */
export async function dataConversationByIdHandler(req: Request, res: Response) {
  try {
    const auth = await authenticateOr401(req, res);
    const conversationId = req.params.id;

    const conversation = await ConversationService.getConversationById(
      auth,
      conversationId
    );

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    res.json(conversation);
  } catch (error) {
    if (error instanceof globalThis.Response) {
      const status = error.status;
      const body = await error.json().catch(() => ({}));
      res.status(status === 403 ? 401 : status).json(body);
      return;
    }
    console.error("Error in /data/conversations/:id:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /data/conversations/stats
 * Returns conversation statistics
 */
export async function dataConversationsStatsHandler(
  req: Request,
  res: Response
) {
  try {
    const auth = await authenticateOr401(req, res);
    const stats = await ConversationService.getStats(auth);
    res.json(stats);
  } catch (error) {
    if (error instanceof globalThis.Response) {
      const status = error.status;
      const body = await error.json().catch(() => ({}));
      res.status(status === 403 ? 401 : status).json(body);
      return;
    }
    console.error("Error in /data/conversations/stats:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
