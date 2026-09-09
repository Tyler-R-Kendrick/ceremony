---
name: Ceremony
description: The implemented local authentication workbench and template studio.
colors:
  primary: "#1749c7"
  primary-hover: "#103aa5"
  canvas: "#f4f6f8"
  surface: "#fff"
  foreground: "#17212d"
  muted: "#526171"
  line: "#dce2e9"
  control-border: "#b8c4d2"
  control-text: "#25364b"
  hover: "#edf2fa"
  selected: "#e2eaff"
  selected-text: "#173d98"
  selected-border: "#c5d4f7"
  context: "#f8fafd"
  input-border: "#aebdce"
  label: "#37485d"
  placeholder: "#637388"
  scope-text: "#364d6d"
  pill-text: "#49596b"
  icon-border: "#c3cedb"
  icon-text: "#2a4363"
  fieldnotes-surface: "#e5efe9"
  fieldnotes-border: "#b9d1c3"
  fieldnotes-text: "#28583d"
  local-status: "#39764e"
  valid: "#286040"
  invalid: "#a03620"
  notice-surface: "#fff6e9"
  notice-border: "#d0a36e"
  notice-text: "#76420d"
  pending: "#435975"
  diagnostic: "#923b1e"
  selection-surface: "#d9e5ff"
  selection-text: "#152f70"
  scrollbar: "#94a3b4"
typography:
  brand:
    fontSize: "24px"
    fontWeight: 700
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "32px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  title:
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  mobile-headline:
    fontSize: "28px"
  card-title:
    fontSize: "18px"
    fontWeight: 600
  service-mark:
    fontSize: "17px"
    fontWeight: 650
  metadata:
    fontSize: "11px"
  section-label:
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.5
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    lineHeight: 1.5
  supporting:
    fontSize: "14px"
  label:
    fontSize: "12px"
    fontWeight: 600
  control:
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  input:
    fontSize: "16px"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "0.9em"
  code-editor:
    fontFamily: "ui-monospace, SFMono-Regular, monospace"
    fontSize: "12px"
    lineHeight: 1.7
  device-code:
    fontFamily: "ui-monospace, monospace"
    fontSize: "30px"
    fontWeight: 600
    letterSpacing: "0.12em"
rounded:
  status-dot: "50%"
  tag: "4px"
  control: "6px"
  tile: "8px"
  card: "12px"
  pill: "20px"
spacing:
  compact: "8px"
  action-gap: "10px"
  small: "12px"
  medium: "16px"
  mobile-inset: "20px"
  section: "24px"
  card-header: "28px"
  workspace: "32px"
  shell: "40px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    typography: "{typography.control}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.control-text}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.control-text}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    typography: "{typography.input}"
  navigation-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.selected-text}"
    rounded: "{rounded.control}"
  connector-selected:
    backgroundColor: "{colors.selected}"
    rounded: "{rounded.tile}"
    padding: "12px"
  pill:
    textColor: "{colors.pill-text}"
    rounded: "{rounded.pill}"
    padding: "4px 9px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
  context:
    backgroundColor: "{colors.context}"
    padding: "28px 24px"
---

# Design System: Ceremony

## Overview

The implemented replacement uses a cool daylight workspace, ink text, cobalt controls, white working surfaces and compact system typography. Borders and restrained tonal differences organize authentication and template authoring without decorative imagery.

This documents the code-led replacement in the local example, following the user's request to replace the former design. The workbench direction was proposed during implementation; it is not an explicitly approved comp or a new brand metaphor. Host applications retain control of their own visual identity.

**Key Characteristics:**

- Cool canvas and white working surfaces.
- Cobalt action and selection states.
- Native controls, compact system type and visible keyboard focus.
- Flat bordered containers with quiet supporting context.

## Colors

### Primary

Cobalt identifies primary actions, focus, the brand mark, caret and native accent. The deeper primary is the button hover state. Pale selected surfaces and their blue border/text distinguish navigation and connector selection.

### Secondary

Neon has a muted green service mark. Green validation/local status and rust or amber error/notice treatments convey state; they do not replace the primary action color.

### Neutral

The canvas sits behind white cards and controls. Ink carries primary text; muted slate carries descriptions and metadata. Context panels and the code editor use the cooler context surface. Separate divider, button and input borders preserve control visibility. Scope tags reuse the hover surface.

## Typography

Use the declared system sans-serif stack throughout the example; no downloaded display font is required. Headings use compact negative tracking, with the page headline reducing to 28px on mobile. Card headers use 18px titles. Supporting copy uses 14px, metadata 11–12px, and paragraph width is capped at 70ch.

Native input text stays at 16px. Code uses the explicit monospace stack; the editor has a 12px size and 1.7 line-height. Device codes use a larger tracked monospace treatment with tabular numerals. There is no serif emphasis role in the replacement.

## Layout

The example shell is centered at a maximum width of 1600px with 40px horizontal padding. Desktop Connect uses a 224px service rail and flexible work area separated by 32px. The working card pairs its ceremony with a 224px context column. Studio uses two equal flexible columns separated by 28px.

At 1100px, shell padding becomes 24px, the service rail becomes 200px, and context moves below the ceremony. At 760px, shell padding becomes 18px and the main grids stack; service tiles wrap with a 150px minimum width. The studio preview appears before the editor. Header and footer wrap, and the small local-workspace header note is hidden.

Use 24–32px working-region spacing and 8–12px control gaps. Buttons and native input/select controls have a 44px minimum height; buttons also have a 44px minimum width. Mobile ceremony padding is 24px vertically and 20px horizontally.

## Elevation & Depth

The example uses no box shadows. White and cool context surfaces, one-pixel borders, and divided card headers/footers establish depth. Focus is a two-pixel cobalt outline with a three-pixel offset.

Button background changes take 120ms with ease-out. A one-pixel downward press translation applies only when the user has no reduced-motion preference.

## Shapes

Small scope tags have the tightest corners, followed by controls, connector tiles, and working cards. Metadata labels use a pill radius; service letter marks are square with rounded corners. Keep native select, file and credential affordances.

## Components

Primary, secondary and quiet buttons share spacing, typography and target size. Primary uses cobalt and white; secondary uses white with a visible border; quiet removes the resting fill and border. Disabled controls have 0.55 opacity and a not-allowed cursor.

Fields use white surfaces, a distinct input border, compact labels and visible keyboard focus. Placeholders use muted slate at full opacity. Code editors use the context surface, vertical resizing and a two-space tab size.

Navigation uses pale blue for the current page. Connector tiles combine a 36px letter mark, service name and auth-method summary, with a selected border and surface. The local-simulation pill is noninteractive outlined metadata. Provider prerequisites sit in a native disclosure beside a link to official authentication documentation.

Cards separate service identity, working content and explanatory footer. The context region shows state, authentication and requested permissions from the current runtime snapshot. Long runtime strings wrap. Studio previews reuse the same ceremony presentation on isolated sample data.

These are reference-app patterns. The reusable library's optional styling and host theme boundary remain independent of this example palette.

## Do's and Don'ts

- Do preserve native form semantics, readable contrast, visible focus and reduced-motion behavior.
- Do keep library styling optional and scoped to the ceremony boundary.
- Do retain runtime-bound authentication status, permissions and actions in live variants.
- Don't replace verified auth behavior with decorative controls or invented claims.
- Don't treat this example identity as a restriction on external host themes.
