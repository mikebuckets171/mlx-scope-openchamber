# Frozen 1.6 fixture support

These retired parsers and pure panel functions are test oracles, not product code. They keep the original
1.6 corpus, compatibility checks and legacy synthetic preview reproducible without a v1 conversion path in
`src/`, `panel/` or `service/` shipping modules. The live service and panel speak contract v2 directly;
`/snapshot` remains retired with HTTP 410.

Do not add runtime imports here. New fixtures should use native v2 bodies (`panel/testing/mock-states.ts`).
