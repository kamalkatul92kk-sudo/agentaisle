import { createContext, useContext } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { themeQuartz, colorSchemeLightWarm, colorSchemeDarkWarm, type ColDef, type GetRowIdParams } from 'ag-grid-community';

// Brand themes built with the AG Grid Theming API (Community): warm coffee palette, light and dark.
const brand = { accentColor: '#b0703a', fontSize: 13, headerFontWeight: 600, rowHoverColor: 'rgba(176,112,58,.08)', spacing: 7, wrapperBorderRadius: 8 };
export const GRID_THEMES = {
  light: themeQuartz.withPart(colorSchemeLightWarm).withParams({ ...brand, headerBackgroundColor: '#faf7f2', backgroundColor: '#fff', oddRowBackgroundColor: '#fdfbf8' }),
  dark: themeQuartz.withPart(colorSchemeDarkWarm).withParams({ ...brand, accentColor: '#d9a36a', backgroundColor: '#1f1812', headerBackgroundColor: '#2b2118', oddRowBackgroundColor: '#231b14', foregroundColor: '#f1e6d8' }),
};
export type ThemeName = keyof typeof GRID_THEMES;
export const GridThemeContext = createContext<ThemeName>('light');
export const useGridTheme = () => GRID_THEMES[useContext(GridThemeContext)];
/** Matching AG Charts Community theme name, so charts follow the grid's light/dark mode. */
export const useChartTheme = () => (useContext(GridThemeContext) === 'dark' ? 'ag-default-dark' : 'ag-default');

export function Grid<T>({ rows, cols, height = 320, rowId, onRowClicked }: { rows: T[]; cols: ColDef<T>[]; height?: number; rowId: (r: T) => string; onRowClicked?: (r: T) => void }) {
  const theme = useGridTheme();
  return (
    <div style={{ height }}>
      <AgGridReact<T> theme={theme} rowData={rows} columnDefs={cols} getRowId={(p: GetRowIdParams<T>) => rowId(p.data)} defaultColDef={{ sortable: true, filter: true, resizable: true, flex: 1, minWidth: 90 }}
        animateRows onRowClicked={(e) => e.data && onRowClicked?.(e.data)} />
    </div>
  );
}
