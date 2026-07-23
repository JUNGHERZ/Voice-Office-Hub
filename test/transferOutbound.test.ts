import "./helpers/env.js"; // MUSS erster Import bleiben (ENV-Pinning vor config-Load)

import assert from "node:assert/strict";
import { test } from "node:test";

import { looksExternal, normalizePhone, toSipgateCli } from "../src/util/phone.js";
import { resolveOutboundTransfer } from "../src/ari/transfer.js";

test("normalizePhone: +49…/0049…/49… vereinheitlichen (DDI-Matching)", () => {
  const ddi = normalizePhone("49236298381975"); // so liefert der Trunk die DDI
  assert.equal(normalizePhone("+49236298381975"), ddi);
  assert.equal(normalizePhone("0049236298381975"), ddi);
  assert.equal(normalizePhone("+49 (0)236 298 381 975".replace(/\(0\)/, "")), ddi);
  assert.equal(ddi, "49236298381975");
  // Interne Durchwahl bleibt unverändert.
  assert.equal(normalizePhone("120"), "120");
});

test("looksExternal: interne Durchwahl vs. externe Nummer", () => {
  assert.equal(looksExternal("101"), false);
  assert.equal(looksExternal("120"), false);
  assert.equal(looksExternal("+4915112345678"), true);
  assert.equal(looksExternal("015112345678"), true);
  assert.equal(looksExternal("0049151123"), true);
});

test("toSipgateCli: Normalisierung auf 49…", () => {
  assert.equal(toSipgateCli("+4915112345678"), "4915112345678");
  assert.equal(toSipgateCli("015112345678"), "4915112345678");
  assert.equal(toSipgateCli("0049 151 1234"), "491511234");
  assert.equal(toSipgateCli("49151"), "49151");
  assert.equal(toSipgateCli(""), "");
});

test("resolveOutboundTransfer: internes Ziel → unverändert, keine CLI", () => {
  const r = resolveOutboundTransfer({ targetNumbers: ["+4930111"], useTransferCallerId: true }, "101", "+4915100");
  assert.equal(r.target, "101");
  assert.equal(r.callerId, undefined);
});

test("resolveOutboundTransfer: extern → eigene Agent-Nummer als Absender (Default)", () => {
  const r = resolveOutboundTransfer(
    { targetNumbers: ["+4930111222", "120"], useTransferCallerId: false },
    "+4915199",
    "+4915100",
  );
  assert.equal(r.target, "+4915199@trunk-endpoint");
  assert.equal(r.callerId, "4930111222"); // eigene DID, nicht die "120"-Durchwahl
});
