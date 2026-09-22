# Context, memory, and archive

Planned full context builder/consolidation: milestone 5. Foundation includes private messages and keyword history lookup.

Load by intent: current articles/settings for a digest; the selected article and a few relevant turns for Q&A; only affected current settings for a proposal; top 3–5 matching historical chunks for recall. Never send an entire archive or the whole recent month. Retrieve under the authenticated user's scope before prompt construction.

Initial defaults: approximately 30-day active window, monthly incremental consolidation, configurable bounded batches. Filter trivial input for consolidation without deleting raw messages. Summaries preserve message provenance; durable candidates are compact; temporary memory/interests expire. Confirmation governs any permanent preference change, including inferred changes.

Archive means excluded from automatic context, still searchable. Deletion is a separate explicit policy and must later cascade to derived summaries/indexes. Keyword/full-text search works first. An embedding provider/model/dimension/budget has not been chosen; no implicit second model or vector implementation is authorized by Luna-only selection.

Tests later must demonstrate old-topic retrieval, no cross-user chunks, bounded context, retry-safe consolidation watermarks, conflicting memory losing to explicit settings, and temporary expiry.
