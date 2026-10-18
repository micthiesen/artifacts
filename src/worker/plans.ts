// What each plan allows a workspace. A workspace is what pays; guests (people
// an artifact is shared with) never need a plan. The operator moves a
// workspace between plans; self-serve workspaces start on Free.

export type PlanId = "free" | "team";
/** null: no limit. `changesPerDay` caps saved versions (each also runs a render check), the work that costs money. */
export type Limits = { artifacts: number | null; bytes: number | null; members: number | null; changesPerDay: number | null };

export const PLANS: Record<PlanId, { label: string; limits: Limits }> = {
  free: { label: "Free", limits: { artifacts: 50, bytes: 250 * 1024 * 1024, members: 3, changesPerDay: 300 } },
  team: { label: "Team", limits: { artifacts: null, bytes: null, members: null, changesPerDay: null } },
};

/** A workspace without a plan set (any the operator made) is on Team. */
export const DEFAULT_PLAN: PlanId = "team";

export function isPlan(v: unknown): v is PlanId {
  return typeof v === "string" && v in PLANS;
}
