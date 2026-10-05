#!/usr/bin/env node
"use strict";

const { performance } = require("node:perf_hooks");

const baseUrl = new URL(process.env.BASE_URL || "http://127.0.0.1:3000");
const requestCount = readBoundedInteger("LOAD_TEST_REQUESTS", 30, 1, 120);
const concurrency = readBoundedInteger("LOAD_TEST_CONCURRENCY", 2, 1, 4);
const fromDate = process.env.LOAD_TEST_FROM || dateOffset(30);
const untilDate = process.env.LOAD_TEST_UNTIL || dateOffset(32);

if (!["http:", "https:"].includes(baseUrl.protocol)) {
  throw new Error("BASE_URL must use HTTP or HTTPS.");
}
if (!isIsoDate(fromDate) || !isIsoDate(untilDate)) {
  throw new Error("LOAD_TEST_FROM and LOAD_TEST_UNTIL must be valid YYYY-MM-DD dates.");
}
if (untilDate <= fromDate) {
  throw new Error("LOAD_TEST_UNTIL must be later than LOAD_TEST_FROM (YYYY-MM-DD).");
}

const endpoints = [
  { name: "health", path: "/api/health" },
  { name: "habitaciones", path: "/api/habitaciones" },
  {
    name: "disponibles",
    path: `/api/habitaciones/disponibles?desde=${encodeURIComponent(fromDate)}&hasta=${encodeURIComponent(untilDate)}`,
  },
];

const results = [];
let nextRequest = 0;

async function requestWorker() {
  while (nextRequest < requestCount) {
    const requestId = nextRequest++;
    const endpoint = endpoints[requestId % endpoints.length];
    const startedAt = performance.now();

    try {
      const response = await fetch(new URL(endpoint.path, baseUrl), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      results.push({
        endpoint: endpoint.name,
        status: response.status,
        latencyMs: performance.now() - startedAt,
      });
      await response.body?.cancel();
    } catch (error) {
      results.push({
        endpoint: endpoint.name,
        status: null,
        latencyMs: performance.now() - startedAt,
        error: error.name || "RequestError",
      });
    }
  }
}

function readBoundedInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function dateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  return Number(sortedValues[Math.ceil(percentileValue * sortedValues.length) - 1].toFixed(2));
}

async function main() {
  const startedAt = performance.now();
  const workers = Array.from({ length: Math.min(concurrency, requestCount) }, requestWorker);
  await Promise.all(workers);

  const elapsedMs = performance.now() - startedAt;
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const failed = results.filter((result) => result.status === null || result.status >= 400);
  const byEndpoint = Object.fromEntries(
    endpoints.map(({ name }) => {
      const endpointResults = results.filter((result) => result.endpoint === name);
      const endpointFailures = endpointResults.filter(
        (result) => result.status === null || result.status >= 400
      );
      const endpointLatencies = endpointResults
        .map((result) => result.latencyMs)
        .sort((a, b) => a - b);
      return [
        name,
        {
          requests: endpointResults.length,
          errors: endpointFailures.length,
          p50Ms: percentile(endpointLatencies, 0.5),
          p95Ms: percentile(endpointLatencies, 0.95),
        },
      ];
    })
  );

  console.log(
    JSON.stringify(
      {
        baseUrl: baseUrl.origin,
        dates: { from: fromDate, until: untilDate },
        requested: requestCount,
        concurrency: Math.min(concurrency, requestCount),
        elapsedMs: Number(elapsedMs.toFixed(2)),
        requestsPerSecond: Number((results.length / (elapsedMs / 1000)).toFixed(2)),
        errors: failed.length,
        latencyMs: {
          min: Number(latencies[0].toFixed(2)),
          mean: Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2)),
          p50: percentile(latencies, 0.5),
          p95: percentile(latencies, 0.95),
          max: Number(latencies[latencies.length - 1].toFixed(2)),
        },
        byEndpoint,
        errorStatuses: failed.reduce((counts, result) => {
          const key = result.status === null ? result.error : String(result.status);
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}),
      },
      null,
      2
    )
  );

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[load-test] ${error.message}`);
  process.exitCode = 1;
});
