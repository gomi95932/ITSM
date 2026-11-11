export function shouldAutoClose(status: string, completedAt: Date | null, clock: Date, hours: number): boolean {
  return status === 'PENDING_CONFIRMATION' && completedAt instanceof Date
    && Number.isFinite(hours) && hours > 0 && clock.getTime() - completedAt.getTime() >= hours * 3600000;
}
