#!/usr/bin/env node
/**
 * GENERATOR for packages/core/sync-registry.json
 *
 * packages/core/src/sync-registry.ts is the SINGLE SOURCE OF TRUTH for the
 * sync model registry. The desktop local-api (apps/desktop/local-api/*.js) is
 * plain JavaScript executed by Node inside Electron and cannot import
 * TypeScript, so it consumes the machine-readable JSON artifact produced by
 * this script instead.
 *
 * Run this script EVERY TIME sync-registry.ts changes, then commit the JSON:
 *
 *   node packages/core/scripts/generate-sync-registry-json.js
 *
 * The generator parses the registry entries out of the TypeScript source and
 * fails loudly if it cannot find them (so drift is caught at generation time,
 * the only place where TS and JSON can be compared in one process).
 */

const fs = require('fs')
const path = require('path')

const REGISTRY_TS = path.join(__dirname, '..', 'src', 'sync-registry.ts')
const OUTPUT_JSON = path.join(__dirname, '..', 'sync-registry.json')

const src = fs.readFileSync(REGISTRY_TS, 'utf8')

// protocolVersion
const pvMatch = src.match(/SYNC_PROTOCOL_VERSION\s*=\s*(\d+)/)
if (!pvMatch) {
  console.error('FATAL: could not find SYNC_PROTOCOL_VERSION in sync-registry.ts')
  process.exit(1)
}
const protocolVersion = parseInt(pvMatch[1], 10)

// Sync model configs — fields appear in a fixed order inside each entry.
const entryRe =
  /model:\s*'([^']+)',[\s\S]*?delegate:\s*'([^']+)',[\s\S]*?isSynced:\s*(true|false),[\s\S]*?isAgencyScoped:\s*(true|false),[\s\S]*?conflictStrategy:\s*ConflictStrategy\.([A-Z_]+)[\s\S]*?syncOrder:\s*(\d+)/g

const models = {}
const syncedModels = []
let match
let totalEntries = 0
while ((match = entryRe.exec(src)) !== null) {
  totalEntries++
  const [, model, delegate, isSynced, isAgencyScoped, conflictStrategy, syncOrder] = match
  models[model] = {
    delegate,
    isSynced: isSynced === 'true',
    isAgencyScoped: isAgencyScoped === 'true',
    conflictStrategy,
    syncOrder: parseInt(syncOrder, 10),
  }
  if (isSynced === 'true') syncedModels.push(model)
}

if (totalEntries === 0) {
  console.error('FATAL: no SyncModelConfig entries parsed from sync-registry.ts — parser out of date?')
  process.exit(1)
}
if (syncedModels.length < 19) {
  console.error('FATAL: unexpectedly few isSynced entries (' + syncedModels.length + ') — parser out of date?')
  process.exit(1)
}

const artifact = {
  _comment:
    'GENERATED ARTIFACT — DO NOT EDIT BY HAND. ' +
    'Single source of truth: packages/core/src/sync-registry.ts (regenerate with ' +
    'packages/core/scripts/generate-sync-registry-json.js whenever the .ts changes). ' +
    'The desktop local-api (plain JS in Electron, cannot import TypeScript) requires ' +
    'this file: apps/desktop/local-api/sync-service.js.',
  protocolVersion,
  generatedFrom: 'packages/core/src/sync-registry.ts',
  syncedModelCount: syncedModels.length,
  // Registry declaration order is canonical (matches getSyncedModelsInOrder intent).
  syncedModels,
  models,
}

fs.writeFileSync(OUTPUT_JSON, JSON.stringify(artifact, null, 2) + '\n')
console.log('[generate-sync-registry-json] wrote ' + OUTPUT_JSON)
console.log('[generate-sync-registry-json] protocolVersion=' + protocolVersion + ', syncedModels=' + syncedModels.length)
