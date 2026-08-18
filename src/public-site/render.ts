import type {
  PublicOrganization,
  PublicSource,
  PublicSourceList,
} from './source-list.ts';

export function renderPublicSourcePage(sourceList: PublicSourceList): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="行政ニーズの早期把握に向けて調査・登録している自治体公式情報源の一覧です。">
    <title>行政情報ソース一覧</title>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <header class="page-header">
      <div class="container">
        <p class="eyebrow">Administrative information sources</p>
        <h1>行政情報ソース一覧</h1>
        <p class="lead">行政ニーズの早期把握に向けて調査・登録している自治体公式情報源の一覧です。</p>
        <dl class="summary-grid" aria-label="登録状況">
          ${renderSummary('登録自治体数', sourceList.organizationCount)}
          ${renderSummary('登録Source数', sourceList.sourceCount)}
          ${renderSummary('継続確認中Source数', sourceList.activeSourceCount)}
        </dl>
      </div>
    </header>
    <main class="container">
      <div class="source-search" role="search">
        <label for="source-search">自治体・Sourceを検索</label>
        <input
          id="source-search"
          type="search"
          placeholder="自治体名、Source名称、URL"
          autocomplete="off"
          data-source-search
        >
        <p class="search-result" aria-live="polite" data-search-result>${sourceList.organizationCount}自治体・${sourceList.sourceCount} Sourceを表示</p>
      </div>
      <p class="no-results" data-no-results hidden>該当するSourceはありません。</p>
      ${renderSection('都道府県', sourceList.prefectures)}
      ${renderSection('市区町村', sourceList.municipalities)}
    </main>
    <footer class="page-footer">
      <div class="container">
        <p>掲載先は各自治体等が運営する公式ページです。</p>
      </div>
    </footer>
    <script type="module" src="./search.js"></script>
  </body>
</html>
`;
}

function renderSection(title: string, organizations: PublicOrganization[]): string {
  const organizationGroups = organizations.map(renderOrganization).join('\n');
  return `<section class="source-section" aria-labelledby="${escapeAttribute(title)}" data-source-section>
        <div class="section-heading">
          <h2 id="${escapeAttribute(title)}">${escapeHtml(title)}</h2>
          <span data-section-count>${organizations.length}自治体</span>
        </div>
        <div class="organization-list">
          ${organizationGroups}
        </div>
      </section>`;
}

function renderOrganization(organization: PublicOrganization): string {
  const sources = organization.sources.map(renderSource).join('\n');
  const activeSourceCount = organization.sources
    .filter((source) => source.status === 'active').length;

  return `<section class="organization-group" data-organization>
            <div class="organization-heading">
              <h3>${escapeHtml(organization.name)}</h3>
              <p class="organization-count"><span>継続確認中 ${activeSourceCount}</span><span aria-hidden="true"> / </span><span>登録 ${organization.sources.length}</span></p>
            </div>
            <ul class="source-list">
              ${sources}
            </ul>
          </section>`;
}

function renderSource(source: PublicSource): string {
  const name = escapeHtml(source.name);
  const url = escapeAttribute(source.url);
  const statusLabel = source.status === 'active' ? '継続確認中' : '現在は未巡回';
  return `<li class="source-item" data-source-item>
              <span class="status-badge status-${source.status}">${statusLabel}</span>
              <div class="source-details">
                <a class="source-name" href="${url}" target="_blank" rel="noopener noreferrer">${name}</a>
                <a class="source-url" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.url)}</a>
              </div>
            </li>`;
}

function renderSummary(label: string, value: number): string {
  return `<div>
            <dt>${escapeHtml(label)}</dt>
            <dd>${value}</dd>
          </div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
