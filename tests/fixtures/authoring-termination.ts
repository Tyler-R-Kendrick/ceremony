import assert from "node:assert/strict";
import {
  attachGenericCeremony,
  disambiguateProvider,
  newAuthoredMethod,
  newConnectorProject,
} from "../../src/core/connector-authoring.js";

export function assertAuthoringTermination() {
  const draft = newConnectorProject();
  draft.manifest.methods.push(
    newAuthoredMethod("api-key", "method-3"),
    newAuthoredMethod("basic", "method-1"),
  );
  assert.equal(attachGenericCeremony(draft, "api-key", "Key").id, "method-4");
  assert.equal(disambiguateProvider("githb").resolved, "github");
  const empty = newConnectorProject();
  assert.equal(attachGenericCeremony(empty, "basic", "Sign in").id, "method-1");
}
