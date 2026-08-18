const searchInput = document.querySelector('[data-source-search]');
const searchResult = document.querySelector('[data-search-result]');
const noResults = document.querySelector('[data-no-results]');

const indexRegions = new Map(
  [...document.querySelectorAll('[data-index-region]')].map((region) => [
    region.getAttribute('data-index-region'),
    {
      empty: region.querySelector('[data-index-empty]'),
      entries: [...region.querySelectorAll('[data-index-entry]')].map((entry) => ({
        element: entry,
        organizationId: entry.querySelector('[data-index-organization]')
          ?.getAttribute('data-index-organization') ?? '',
      })),
    },
  ]),
);

const sections = [...document.querySelectorAll('[data-source-section]')].map((section) => ({
  element: section,
  count: section.querySelector('[data-section-count]'),
  empty: section.querySelector('[data-empty-region]'),
  organizations: [...section.querySelectorAll('[data-organization]')].map((organization) => {
    const organizationName = organization.querySelector('h3')?.textContent ?? '';
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

      for (const organization of section.organizations) {
        let organizationSourceCount = 0;

        for (const source of organization.sources) {
          const matches = terms.every((term) => source.searchText.includes(term));
          source.element.hidden = !matches;
          if (matches) organizationSourceCount += 1;
        }

        organization.element.hidden = organizationSourceCount === 0;
        if (organizationSourceCount > 0) {
          visibleOrganizationIds.add(organization.id);
          sectionOrganizationCount += 1;
          visibleSourceCount += organizationSourceCount;
        }
      }

      section.element.hidden = isSearching && sectionOrganizationCount === 0;
      if (section.count !== null) {
        section.count.textContent = `${sectionOrganizationCount}自治体`;
      }
      if (section.empty !== null) {
        section.empty.hidden = isSearching || section.organizations.length > 0;
      }
      visibleOrganizationCount += sectionOrganizationCount;
    }

    for (const region of indexRegions.values()) {
      let visibleIndexOrganizationCount = 0;
      for (const entry of region.entries) {
        const visible = visibleOrganizationIds.has(entry.organizationId);
        entry.element.hidden = !visible;
        if (visible) visibleIndexOrganizationCount += 1;
      }
      if (region.empty !== null) {
        region.empty.hidden = visibleIndexOrganizationCount !== 0;
        region.empty.textContent = isSearching ? '該当自治体なし' : '登録自治体なし';
      }
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
