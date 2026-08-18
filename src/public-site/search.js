const searchInput = document.querySelector('[data-source-search]');
const searchResult = document.querySelector('[data-search-result]');
const noResults = document.querySelector('[data-no-results]');

const sections = [...document.querySelectorAll('[data-source-section]')].map((section) => ({
  element: section,
  count: section.querySelector('[data-section-count]'),
  organizations: [...section.querySelectorAll('[data-organization]')].map((organization) => {
    const organizationName = organization.querySelector('h3')?.textContent ?? '';
    return {
      element: organization,
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
    let visibleOrganizationCount = 0;
    let visibleSourceCount = 0;

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
          sectionOrganizationCount += 1;
          visibleSourceCount += organizationSourceCount;
        }
      }

      section.element.hidden = sectionOrganizationCount === 0;
      if (section.count !== null) {
        section.count.textContent = `${sectionOrganizationCount}自治体`;
      }
      visibleOrganizationCount += sectionOrganizationCount;
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
