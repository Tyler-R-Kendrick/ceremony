import { createElement, type ReactNode } from "react";

/** A provider's own colour, and its mark where the shape is exactly known. */
export interface Brand {
  tint: string;
  /** What reads on the tint. Dark for a light brand. */
  ink: string;
  logo?: ReactNode;
}

const svg = (children: ReactNode, viewBox = "0 0 24 24") =>
  createElement(
    "svg",
    { viewBox, role: "presentation", focusable: "false", fill: "currentColor" },
    children,
  );

/** Brand colours, and marks only where the geometry is a shape and not a drawing. */
export const brands: Record<string, Brand> = {
  account: { tint: "#2540d9", ink: "#ffffff" },
  github: { tint: "#1f2328", ink: "#ffffff" },
  stripe: { tint: "#635bff", ink: "#ffffff" },
  jira: { tint: "#0052cc", ink: "#ffffff" },
  // Dark ink: white on this green is about 1.8:1, and the mark carries a letter.
  supabase: { tint: "#3ecf8e", ink: "#0e1621" },
  vercel: {
    tint: "#000000",
    ink: "#ffffff",
    logo: svg(
      createElement("path", { key: "t", d: "M12 3 22 21H2Z" }),
      "0 0 24 24",
    ),
  },
  linear: { tint: "#5e6ad2", ink: "#ffffff" },
};

export const brandOf = (id: string): Brand =>
  brands[id] ?? { tint: "#5a6679", ink: "#ffffff" };
