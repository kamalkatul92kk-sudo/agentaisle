import { createRoot } from 'react-dom/client';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import { ModuleRegistry as ChartsModuleRegistry, BarSeriesModule, CategoryAxisModule, NumberAxisModule, LegendModule } from 'ag-charts-community';
import { App } from './App';
import './styles.css';

ModuleRegistry.registerModules([AllCommunityModule]);
ChartsModuleRegistry.registerModules([BarSeriesModule, CategoryAxisModule, NumberAxisModule, LegendModule]);
createRoot(document.getElementById('root')!).render(<App />);
