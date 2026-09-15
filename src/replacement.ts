export interface PreviousDatabase {
  remote: boolean,
  name?: string,
  organization?: string,
  group?: string
}

export function needsDatabaseReplacement(input: {
  phase: string,
  previous: PreviousDatabase | undefined,
  remote: boolean,
  name?: string,
  organization?: string,
  group?: string
}) {
  if(input.phase !== "update" || !input.previous) return false;
  if(input.previous.remote !== input.remote) return true;
  if(
    !input.remote ||
    (input.name === undefined && input.organization === undefined && input.group === undefined)
  ) {
    return false;
  }
  return input.remote && (
    (input.name !== undefined && input.previous.name !== input.name) ||
    input.previous.organization !== input.organization ||
    input.previous.group !== input.group
  );
}
