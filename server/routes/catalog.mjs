// Model catalogue routes (docs/API.md §10.8).
import { Catalog } from '../catalog/index.mjs';

export function registerCatalogRoutes(r, app) {
  app.catalog ||= new Catalog(app);
  r.get('/api/catalog', ({ query }) => app.catalog.list(Catalog.parseQuery(query)));
  r.get('/api/catalog/model', ({ query }) => app.catalog.detail({ source: query.get('source') || 'local', id: query.get('id') }));
}
