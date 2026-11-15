# Bundled dictionary sources

Agentero ships a read-only, indexed English–Chinese dictionary with desktop installers. End users do not download, import, or maintain a glossary.

| Source | Snapshot | Use | License |
| --- | --- | --- | --- |
| [ECDICT](https://github.com/skywind3000/ECDICT) | `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b` | 770,611 entries: pronunciation, Chinese glosses, English definitions and inflected-form links | MIT, see `ECDICT-LICENSE.txt` |
| [AI Engineering](https://github.com/fancyboi999/ai-engineering-from-scratch-zh) | `2a9d8d23e65723f48c1ee5c82f122258e6229932` | One reviewed compound entry: LLM-as-a-Judge; localized display name 大模型评审 | MIT, see `AI-ENGINEERING-LICENSE.txt` |
| [AI/LLM Glossary](https://github.com/JingHao-Leon/ai-llm-glossary) | `abc74818e14884f0e28fe6465c2328c68f9aae53` | 148 specialist entries / 184 English aliases; term names and the first definition paragraph | MIT, see `AI-GLOSSARY-LICENSE.txt` |

The source projects publish these licenses; this notice records their published terms and does not imply independent authorship or dictionary endorsement by Agentero. ECDICT documents its aggregation history in its upstream README. Preserve all three license notices and this provenance when redistributing the data. The AI glossary is a specialist reference maintained by its author, not an exhaustive or peer-reviewed terminology standard.

`sources.json` pins the source revision and the full ECDICT CSV SHA-256. `scripts/prepare-dictionary.mjs` verifies that digest before parsing, writes a temporary SQLite database, and publishes it only after construction. Desktop dev/release hooks stage it automatically. `pnpm dictionary:verify` checks the actual staged resource. The generated 75.4 MB database, raw CSV and test media are excluded from Git; the database and license files are included in installers. Lookup never downloads data or requires an API key.

Compound lookup treats common hyphens and whitespace as equivalent separators. Full known terms take precedence over abbreviations inside them; standalone abbreviations still match elsewhere. Dictionary cards and sentence constraints use the same source records.

The small AI snapshot in `src/lib/translate/data/ai-terms.json` is a derivative of the pinned source: relative Markdown links are removed, aliases indexed, `LLM` displayed as `大模型`, and `KV Cache` as `键值缓存`. The supplementary compound entry contains only its headword and meaning line from the pinned MIT AI Engineering glossary; the Chinese display name is localized by Agentero. No tutorials, images, benchmark tables, examples or audio are copied. Reproduce it with `node scripts/update-dictionary-terms.mjs` (`--check` compares without writing; `--source-dir <ai-glossary checkout> --compound-source-dir <ai-engineering checkout>` works offline).

Dictionary entries retain a source link in their cards and saved PDF marks. Any optional model interpretation appears separately under “In context · AI” and does not replace the source definitions. Updating a source requires reviewing its data/license, updating the pinned revision/checksum, reproducing the snapshot and rerunning dictionary verification; no floating `main`/`master` downloads ship.
