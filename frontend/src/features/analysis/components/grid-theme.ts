/**
 * AG Grid Community setup for the finance spreadsheet (plan §3, §15).
 * Colours are Strata CSS variables, so light and dark mode follow the app theme.
 */
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export const strataGridTheme = themeQuartz.withParams({
  accentColor: "var(--primary)",
  backgroundColor: "var(--card)",
  foregroundColor: "var(--foreground)",
  textColor: "var(--foreground)",
  borderColor: "var(--border)",
  chromeBackgroundColor: "var(--muted)",
  headerBackgroundColor: "var(--muted)",
  headerTextColor: "var(--muted-foreground)",
  headerFontWeight: 600,
  headerFontSize: 11.5,
  fontFamily: "var(--font-geist-sans)",
  fontSize: 13,
  oddRowBackgroundColor: "color-mix(in oklch, var(--muted) 40%, transparent)",
  rowHoverColor: "color-mix(in oklch, var(--primary) 7%, transparent)",
  selectedRowBackgroundColor: "color-mix(in oklch, var(--primary) 12%, transparent)",
  rangeSelectionBorderColor: "var(--primary)",
  rowHeight: 38,
  headerHeight: 40,
  spacing: 6,
  wrapperBorderRadius: 12,
  borderRadius: 8,
  browserColorScheme: "inherit",
});
