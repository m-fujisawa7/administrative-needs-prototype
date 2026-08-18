const searchInput = document.querySelector('[data-source-search]');
const searchResult = document.querySelector('[data-search-result]');
const noResults = document.querySelector('[data-no-results]');

const indexRegions = new Map(
  [...document.querySelectorAll('[data-index-region]')].map((region) => [
    region.getAttribute('data-index-region'),
    {
      element: region,
      layers: [...region.querySelectorAll('[data-index-layer]')].map((layer) => ({
        element: layer,
        empty: layer.querySelector('[data-index-empty]'),
        entries: [...layer.querySelectorAll('[data-index-entry]')].map((entry) => ({
          element: entry,
          organizationId: entry.querySelector('[data-index-organization]')
            ?.getAttribute('data-index-organization') ?? '',
        })),
      })),
    },
  ]),
);

const sections = [...document.querySelectorAll('[data-source-section]')].map((section) => ({
  element: section,
  count: section.querySelector('[data-section-count]'),
  layers: [...section.querySelectorAll('[data-source-layer]')].map((layer) => ({
    element: layer,
    count: layer.querySelector('[data-layer-count]'),
    empty: layer.querySelector('[data-empty-layer]'),
    organizations: [...layer.querySelectorAll('[data-organization]')].map((organization) => {
      const organizationName = organization.querySelector('[data-organization-name]')
        ?.textContent ?? '';
      return {
        element: organization,
        id: organization.getAttribute('data-organization-id') ?? '',
        sources: [...organization.querySelectorAll('[data-source-item]')].map((source) => ({
          element: source,
          searchText: normalize([
            organizationName,
            source.querySelector('.source-name')?.textContent ?? '',
            source.querySelector('.source-url')?.textContent ?? '',
          ].join(' ')),
        })),
      };
    }),
  })),
}));

if (searchInput instanceof HTMLInputElement && searchResult !== null && noResults !== null) {
  const filterSources = () => {
    const terms = normalize(searchInput.value).split(/\s+/).filter(Boolean);
    const isSearching = terms.length > 0;
    let visibleOrganizationCount = 0;
    let visibleSourceCount = 0;
    const visibleOrganizationIds = new Set();

    for (const section of sections) {
      let sectionOrganizationCount = 0;

      for (const layer of section.layers) {
        let layerOrganizationCount = 0;

        for (const organization of layer.organizations) {
          let organizationSourceCount = 0;

          for (const source of organization.sources) {
            const matches = terms.every((term) => source.searchText.includes(term));
            source.element.hidden = !matches;
            if (matches) organizationSourceCount += 1;
          }

          organization.element.hidden = organizationSourceCount === 0;
          if (organizationSourceCount > 0) {
            visibleOrganizationIds.add(organization.id);
            layerOrganizationCount += 1;
            visibleSourceCount += organizationSourceCount;
          }
        }

        layer.element.hidden = isSearching && layerOrganizationCount === 0;
        if (layer.count !== null) {
          layer.count.textContent = `${layerOrganizationCount}自治体`;
        }
        if (layer.empty !== null) {
          layer.empty.hidden = isSearching || layer.organizations.length > 0;
        }
        sectionOrganizationCount += layerOrganizationCount;
      }

      section.element.hidden = isSearching && sectionOrganizationCount === 0;
      if (section.count !== null) {
        section.count.textContent = `${sectionOrganizationCount}自治体`;
      }
      visibleOrganizationCount += sectionOrganizationCount;
    }

    for (const region of indexRegions.values()) {
      let visibleRegionOrganizationCount = 0;
      for (const layer of region.layers) {
        let visibleLayerOrganizationCount = 0;
        for (const entry of layer.entries) {
          const visible = visibleOrganizationIds.has(entry.organizationId);
          entry.element.hidden = !visible;
          if (visible) visibleLayerOrganizationCount += 1;
        }
        layer.element.hidden = isSearching && visibleLayerOrganizationCount === 0;
        if (layer.empty !== null) {
          layer.empty.hidden = isSearching || layer.entries.length > 0;
        }
        visibleRegionOrganizationCount += visibleLayerOrganizationCount;
      }
      region.element.hidden = isSearching && visibleRegionOrganizationCount === 0;
    }

    searchResult.textContent = `${visibleOrganizationCount}自治体・${visibleSourceCount} Sourceを表示`;
    noResults.hidden = visibleSourceCount !== 0;
  };

  searchInput.addEventListener('input', filterSources);
  filterSources();
}

function normalize(value) {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP').trim();
}
