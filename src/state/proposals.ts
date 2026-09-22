/**
 * Decision-record persistence.
 *
 * Each record is written once — proposal row, one row per agent vote, one row
 * per dialogue turn — and never updated. The full record also lives in
 * `payload`, so reads return exactly what was decided even if the shape of the
 * normalized tables changes later.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb, saveDb } from "./db.js";
import { tradeProposals, agentVotes, dialogueTranscripts } from "./schema.js";
import type { DecisionRecord, ProposalStatus } from "../agents/types.js";

/** Persist a decision record atomically. Returns its id. */
export async function saveDecisionRecord(record: DecisionRecord): Promise<number> {
  const db = await getDb();

  // One transaction: a failure partway can't leave a proposal without its votes.
  const id = db.transaction((tx) => {
    const row = tx
      .insert(tradeProposals)
      .values({
        symbol: record.symbol,
        action: record.action,
        proposedCall: record.proposedCall,
        status: record.status,
        confidence: record.confidence?.confidence ?? null,
        preDialogueConfidence: record.preDialogueConfidence,
        threshold: record.confidence?.threshold ?? 0,
        entry: record.sentinel?.entry ?? null,
        stop: record.sentinel?.stop ?? null,
        target: record.sentinel?.target ?? null,
        trigger: record.trigger,
        vetoReason: record.vetoReason,
        summary: record.summary,
        // Rewritten below once the id is known, so the payload carries it.
        payload: "{}",
        createdAt: new Date(record.createdAt).toISOString(),
      })
      .returning({ id: tradeProposals.id })
      .get();

    tx.update(tradeProposals)
      .set({ payload: JSON.stringify({ ...record, id: row.id }) })
      .where(eq(tradeProposals.id, row.id))
      .run();

    for (const vote of record.votes) {
      tx.insert(agentVotes)
        .values({
          proposalId: row.id,
          agent: vote.agent,
          direction: vote.direction,
          confidence: vote.confidence,
          rationale: vote.rationale,
          isDissent: vote.isDissent,
          veto: vote.veto,
        })
        .run();
    }

    for (const turn of record.dialogue.turns) {
      tx.insert(dialogueTranscripts)
        .values({
          proposalId: row.id,
          round: turn.round,
          agent: turn.agent,
          message: turn.message,
          confidenceBefore: turn.confidenceBefore,
          confidenceAfter: turn.confidenceAfter,
        })
        .run();
    }

    return row.id;
  });

  saveDb();
  return id;
}

function parse(payload: string): DecisionRecord | null {
  try {
    return JSON.parse(payload) as DecisionRecord;
  } catch {
    return null;
  }
}

export async function getDecisionRecord(id: number): Promise<DecisionRecord | null> {
  const db = await getDb();
  const row = db.select().from(tradeProposals).where(eq(tradeProposals.id, id)).get();
  return row ? parse(row.payload) : null;
}

/** Most recent first. */
export async function listDecisionRecords(
  opts: { limit?: number; symbol?: string; status?: ProposalStatus } = {}
): Promise<DecisionRecord[]> {
  const db = await getDb();
  const filters = [
    opts.symbol ? eq(tradeProposals.symbol, opts.symbol.toUpperCase()) : undefined,
    opts.status ? eq(tradeProposals.status, opts.status) : undefined,
  ].filter((f) => f !== undefined);

  const rows = db
    .select()
    .from(tradeProposals)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(tradeProposals.createdAt), desc(tradeProposals.id))
    .limit(opts.limit ?? 10)
    .all();

  return rows.map((r) => parse(r.payload)).filter((r): r is DecisionRecord => r !== null);
}
