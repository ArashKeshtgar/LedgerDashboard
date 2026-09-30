// Job families. IT support / help desk roles are built from a different
// résumé variant ("itsupport") and are kept visually and filter-wise apart
// from developer roles. The server derives `track` from the row's variant.
export const TRACKS = {
  dev: { label: "Developer", short: "Dev", icon: "💻" },
  it: { label: "IT Support", short: "IT", icon: "🛠️" },
};

export function trackOf(row) {
  return row?.track || (row?.variant === "itsupport" ? "it" : "dev");
}

export function trackForVariant(variant) {
  return variant === "itsupport" ? "it" : "dev";
}
