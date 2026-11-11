// Never accept free-form request/upstream values in an operational trace.
export function routingDiagnostic(
  stage,
  outcome,
  status,
  report = console.info,
) {
  if (
    !["status", "context"].includes(stage) ||
    ![
      "allowed",
      "claim_denied",
      "household_missing",
      "shared_response",
    ].includes(outcome) ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  )
    return;
  report("events-routing-check", stage, outcome, status);
}
