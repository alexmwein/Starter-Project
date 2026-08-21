# Peptide Content Intel background briefs

This job turns the tracked `videos-data.js` evidence ledger into a small,
machine-readable `ai-briefs.js` artifact. It has no Generate interface and does
not depend on the OVO Command Center.

The GitHub workflow runs only on the self-hosted `ovo-studio` Mac Studio. It
exits before contacting Ollama when the input digest is unchanged, and defers
when free memory is below 35% or one-minute load is above 75% of core count.
An hourly schedule provides the cheap retry after a deferral.

`qwen3:1.7b` may choose only exact eligible evidence IDs and one of five
allowlisted structural angles. Deterministic templates compile the final hooks
and beats. Source transcript text is bounded for the runtime prompt, never
retained in the browser artifact, and the model never controls repository
actions. The request uses one 4K context, a 320-token output cap, one request at
a time, and `keep_alive: 0` so the model unloads immediately.

Generated output is updated with fast-forward commits on the dedicated
`automation/peptide-ai-output` branch. It never writes to `main`, requests pull
request permission, or weakens repository protection. Before inference, each
run restores the latest artifact digest from that branch, so unchanged evidence
exits without loading the model.

Run the focused checks with:

```bash
node --test test/peptide-content-intel-ai.test.mjs
node tools/peptide-content-intel/generate_ai_briefs.mjs --dry-run
```
