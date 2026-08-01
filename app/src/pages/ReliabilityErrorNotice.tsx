import { toPlayerError } from "../application/playerError";
import { reliabilityErrorCode } from "../application/reliabilityUi";

export function ReliabilityErrorNotice({ error, prefix }: { error: unknown; prefix?: string }) {
  if (error === null || error === undefined) return null;
  const detail = toPlayerError({ code: reliabilityErrorCode(error) });
  return (
    <div className="reliability-error" role="alert">
      {prefix && <strong>{prefix}</strong>}
      <p>{detail.whatHappened}</p>
      <p>{detail.whatIsSafe}</p>
      <p>{detail.nextAction}</p>
      <code>{detail.code}</code>
    </div>
  );
}
