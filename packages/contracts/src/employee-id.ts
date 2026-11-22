export function validEmployeeId(value:unknown):value is string {
  return typeof value==='string'&&(/^[A-Za-z0-9_-]{1,100}$/.test(value)||/^ding:[a-f0-9]{64}$/.test(value));
}
