/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Project, ProjectContainer } from './project';
import { OctokitProvider } from "./octokitProvider";
import AbortController from "abort-controller";

interface RawNotebookCell {
	language: string;
	value: string;
	kind: vscode.CellKind;
}

export class IssuesNotebookProvider implements vscode.NotebookProvider {

	constructor(
		readonly container: ProjectContainer,
		readonly octokit: OctokitProvider
	) { }

	async resolveNotebook(editor: vscode.NotebookEditor): Promise<void> {


		editor.document.languages = ['github-issues'];

		let contents = '';
		try {
			contents = Buffer.from(await vscode.workspace.fs.readFile(editor.document.uri)).toString('utf8');
		} catch {
		}

		let raw: RawNotebookCell[];
		try {
			raw = <RawNotebookCell[]>JSON.parse(contents);
		} catch {
			//?
			raw = [];
		}
		await editor.edit(editBuilder => {
			for (let item of raw) {
				editBuilder.insert(
					0,
					item.value,
					item.language,
					item.kind,
					[],
					{ editable: true, runnable: true }
				);
			}
		});

		// (1) register a new project for this notebook
		// (2) eager fetch and analysis of all cells
		// todo@API unregister
		// todo@API add new cells
		const project = new Project();
		this.container.register(
			editor.document.uri,
			project,
			uri => editor.document.cells.some(cell => cell.uri.toString() === uri.toString()),
		);
		setTimeout(async () => {
			try {
				for (let cell of editor.document.cells) {
					if (cell.cellKind === vscode.CellKind.Code) {
						const doc = await vscode.workspace.openTextDocument(cell.uri);
						project.getOrCreate(doc);
					}
				}
			} catch (err) {
				console.error('FAILED to eagerly feed notebook cell document into project');
				console.error(err);
			}
		}, 0);
	}

	async executeCell(document: vscode.NotebookDocument, cell: vscode.NotebookCell | undefined, token: vscode.CancellationToken): Promise<void> {

		if (!cell) {
			// run them all
			for (let cell of document.cells) {
				if (cell.cellKind === vscode.CellKind.Code) {
					await this.executeCell(document, cell, token);
				}
			}
			return;
		}

		const doc = await vscode.workspace.openTextDocument(cell.uri);
		const project = this.container.lookupProject(doc.uri);
		const allQueryData = project.queryData(doc);


		// update all symbols defined in the cell so that
		// more recent values win
		const query = project.getOrCreate(doc);
		project.symbols.update(query);

		const now = Date.now();
		let allItems: SearchIssuesAndPullRequestsResponseItemsItem[] = [];
		let totalCount: number = 0;
		// fetch
		try {
			const abortCtl = new AbortController();
			token.onCancellationRequested(_ => abortCtl.abort());

			for (let queryData of allQueryData) {
				const octokit = await this.octokit.lib();

				let page = 0;
				let count = 0;
				while (!token.isCancellationRequested) {

					const response = await octokit.search.issuesAndPullRequests({
						q: queryData.q,
						sort: (<any>queryData.sort),
						order: queryData.order,
						per_page: 100,
						page,
						request: { signal: abortCtl.signal }
					});
					count += response.data.items.length;
					totalCount += response.data.total_count;
					allItems = allItems.concat(<any>response.data.items);
					if (count >= Math.min(1000, response.data.total_count)) {
						break;
					}
					page += 1;
				}
			}
		} catch (err) {
			// ignore cancellation
			if (token.isCancellationRequested) {
				return;
			}
			// print as error
			cell.outputs = [{
				outputKind: vscode.CellOutputKind.Error,
				ename: err instanceof Error && err.name || 'error',
				evalue: err instanceof Error && err.message || JSON.stringify(err, undefined, 4),
				traceback: []
			}];
			return;
		}

		// sort
		const [first] = allQueryData;
		const comparator = allQueryData.length >= 2 && allQueryData.every(item => item.sort === first.sort) && cmp.byName.get(first.sort!);
		if (comparator) {
			allItems.sort(first.sort === 'asc' ? cmp.invert(comparator) : comparator);
		}

		let hasManyRepos = false;
		let lastRepo: string | undefined;
		for (let item of allItems) {
			if (!lastRepo) {
				lastRepo = item.repository_url;
			} else if (lastRepo !== item.repository_url) {
				hasManyRepos = true;
				break;
			}
		}

		// "render"
		const duration = Date.now() - now;
		const seen = new Set<number>();
		let html = getHtmlStub();
		let md = '';
		let count = 0;
		for (let item of allItems) {
			if (seen.has(item.id)) {
				continue;
			}
			seen.add(item.id);

			// markdown
			md += `- [#${item.number}](${item.html_url}) ${item.title} [${item.labels.map(label => `${label.name}`).join(', ')}]`;
			if (item.assignee) {
				md += `- [@${item.assignee.login}](${item.assignee.html_url})\n`;
			}
			md += '\n';

			// html
			html += renderItemAsHtml(item, hasManyRepos, count++ > 12);
		}

		//collapse/expand btns
		html += `<div class="collapse"><script>function toggle(element, more) { element.parentNode.parentNode.classList.toggle("collapsed", !more)}</script><span class="more" onclick="toggle(this, true)">▼ Show More</span><span class="less" onclick="toggle(this, false)">▲ Show Less</span></div>`;

		// status line
		html += `<div class="stats" data-ts=${now}>${totalCount} results${totalCount !== allItems.length ? ` (showing ${allItems.length})` : ''}, queried {{NOW}}, took ${(duration / 1000).toPrecision(2)}secs</div>`;
		html += `<script>
			var node = document.currentScript.parentElement.querySelector(".stats");
			node.innerText = node.innerText.replace("{{NOW}}", new Date(Number(node.dataset['ts'])).toLocaleString());
			</script>`;

		cell.outputs = [{
			outputKind: vscode.CellOutputKind.Rich,
			data: {
				['text/html']: `<div class="${count > 12 ? 'large collapsed' : ''}">${html}</div>`,
				['text/markdown']: md
			}
		}];
	}

	async save(document: vscode.NotebookDocument): Promise<boolean> {
		let contents: RawNotebookCell[] = [];
		for (let cell of document.cells) {
			contents.push({
				kind: cell.cellKind,
				language: cell.language,
				value: cell.source
			});
		}
		await vscode.workspace.fs.writeFile(document.uri, Buffer.from(JSON.stringify(contents)));
		return true;
	}
}

namespace cmp {

	export type ItemComparator = (a: SearchIssuesAndPullRequestsResponseItemsItem, b: SearchIssuesAndPullRequestsResponseItemsItem) => number;

	export const byName = new Map([
		['comments', compareByComments],
		['created', compareByCreated],
		['updated', compareByUpdated],
	]);

	export function invert<T>(compare: (a: T, b: T) => number) {
		return (a: T, b: T) => compare(a, b) * -1;
	}

	export function compareByComments(a: SearchIssuesAndPullRequestsResponseItemsItem, b: SearchIssuesAndPullRequestsResponseItemsItem): number {
		return a.comments - b.comments;
	}

	export function compareByCreated(a: SearchIssuesAndPullRequestsResponseItemsItem, b: SearchIssuesAndPullRequestsResponseItemsItem): number {
		return Date.parse(a.created_at) - Date.parse(b.created_at);
	}

	export function compareByUpdated(a: SearchIssuesAndPullRequestsResponseItemsItem, b: SearchIssuesAndPullRequestsResponseItemsItem): number {
		return Date.parse(a.updated_at) - Date.parse(b.updated_at);
	}
}

export function getHtmlStub(): string {
	return `
<style>
	.item-row {
		display: flex; 
		padding: .5em 0;
		color: var(--vscode-foreground);
	}
	.item-row:hover {
		background-color: var(--vscode-list-hoverBackground);
	}
	.collapsed > .item-row.hide {
		display: none;
	}
	.title {
		color: var(--vscode-foreground) !important;
		font-size: 1em;
		text-decoration: none;
	}
	.title:hover {
		text-decoration: underline;
	}
	.title.repo {
		opacity: 70%;
		padding-right: 8px;
	}
	.label {
		font-size: .8em;
		margin: 0 2px;
		padding: 2px
	}
	.label a {
		padding: 2px;
	}
	.status {
		font-size: .8em;
		opacity: 60%;
		padding-top: .5em;
	}
	.assignee {
		flex: shrink;
	}
	.user {
		display: flex;
	}
	.user img {
		padding: 0.1em;
		min-width: 22px;
	}
	.item-state {
		flex: shrink;
		padding: 0 .3em;
		opacity: 60%;
	}
	.stats {
		text-align: center;
		font-size: .7em;
		opacity: 60%;
		padding-top: .6em;
	}
	.collapse {
		text-align: center;
		font-size: .9em;
		opacity: 60%;
		display: none;
		cursor: pointer;
		padding: 0.3em 0;
	}
	.large > .collapse {
		display: inherit;
	}
	.collapse > span {
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
		padding: 3px;
	}
	.large.collapsed > .collapse > .less {
		display: none;
	}
	.large:not(.collapsed) > .collapse > .more {
		display: none;
	}
	.item-row .start-working {
		display:none;
	}
	.item-row .start-working a {
		color: var(--vscode-foreground) !important;
		font-size: 0.9em;
		text-decoration: none;
	}
	.item-row .start-working a:hover {
		text-decoration: underline;
	}
	.item-row:hover .start-working {
		display:inline;
	}
</style>`;
}

export function renderItemAsHtml(item: SearchIssuesAndPullRequestsResponseItemsItem, showRepo: boolean, hide: boolean): string {


	const closed = `<svg class="octicon octicon-issue-closed closed" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M7 10h2v2H7v-2zm2-6H7v5h2V4zm1.5 1.5l-1 1L12 9l4-4.5-1-1L12 7l-1.5-1.5zM8 13.7A5.71 5.71 0 012.3 8c0-3.14 2.56-5.7 5.7-5.7 1.83 0 3.45.88 4.5 2.2l.92-.92A6.947 6.947 0 008 1C4.14 1 1 4.14 1 8s3.14 7 7 7 7-3.14 7-7l-1.52 1.52c-.66 2.41-2.86 4.19-5.48 4.19v-.01z"></path></svg>`;
	const open = `<svg class="octicon octicon-issue-opened open" viewBox="0 0 14 16" version="1.1" width="14" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M7 2.3c3.14 0 5.7 2.56 5.7 5.7s-2.56 5.7-5.7 5.7A5.71 5.71 0 011.3 8c0-3.14 2.56-5.7 5.7-5.7zM7 1C3.14 1 0 4.14 0 8s3.14 7 7 7 7-3.14 7-7-3.14-7-7-7zm1 3H6v5h2V4zm0 6H6v2h2v-2z"></path></svg>`;


	let entityMap: Record<string, string> = {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
		'/': '&#x2F;',
		'`': '&#x60;',
		'=': '&#x3D;'
	};

	function escapeHtml(string: string) {
		return string.replace(/[&<>"'`=\/]/g, s => entityMap[s]);
	}

	function getContrastColor(color: string): string {
		// Color algorithm from https://stackoverflow.com/questions/1855884/determine-font-color-based-on-background-color
		const r = Number.parseInt(color.substr(0, 2), 16);
		const g = Number.parseInt(color.substr(2, 2), 16);
		const b = Number.parseInt(color.substr(4, 2), 16);
		return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.5 ? 'black' : 'white';
	}

	//#region GH PR Integration
	//todo@jrieken - have API that allows the PR extension to contribute this
	let startWorking: string = '';
	if (!item.closed_at
		&& vscode.extensions.getExtension('github.vscode-pull-request-github-insiders')
	) {
		let repoPos = item.repository_url.lastIndexOf('/');
		let ownerPos = item.repository_url.lastIndexOf('/', repoPos - 1);
		startWorking = `
		<span class="start-working">
		<span>&nbsp;\u2022&nbsp;</span>
		<a href="${vscode.Uri.parse('command:issue.startWorking').with({
			query: JSON.stringify([{
				owner: item.repository_url.substring(repoPos, ownerPos),
				repo: item.repository_url.substring(ownerPos),
				number: item.number
			}])
		}).toString()}">Start Working...</a>
		</span>`;
	}
	//#endregion

	function getRepoLabel(): string {
		if (!showRepo) {
			return '';
		}
		let match = /.+\/(.+\/.+)$/.exec(item.repository_url);
		if (!match) {
			return '';
		}
		return `<a href="https://github.com/${match[1]}" class="repo title">${match[1]}</a>`;
	}

	return `
<div class="item-row ${hide ? 'hide' : ''}">
	<div class="item-state">${item.closed_at ? closed : open}</div>
	<div style="flex: auto;">
	${getRepoLabel()}<a href="${item.html_url}" class="title">${escapeHtml(item.title)}</a>
	${item.labels.map(label => `<span class="label" style="background-color: #${label.color};"><a style="color: ${getContrastColor(label.color)};">${label.name}</a></span>`).join('')}
	${startWorking}
	<div class="status">
		<span>#${item.number} opened ${new Date(item.created_at).toLocaleDateString()} by ${escapeHtml(item.user.login)}</span>
	</div>
	</div>
	<div class="user">${!item.assignees ? '' : item.assignees.map(user => `<a href="${user.html_url}"><img src="${user.avatar_url}" width="20" height="20" alt="@${user.login}"></a>`).join('')}</div>
</div>
`;
}

//#region COPY of type definitions that are well hidden inside @octokit/types
declare type SearchIssuesAndPullRequestsResponseItemsItemUser = {
	avatar_url: string;
	events_url: string;
	followers_url: string;
	following_url: string;
	gists_url: string;
	gravatar_id: string;
	html_url: string;
	id: number;
	login: string;
	node_id: string;
	organizations_url: string;
	received_events_url: string;
	repos_url: string;
	starred_url: string;
	subscriptions_url: string;
	type: string;
	url: string;
};
declare type SearchIssuesAndPullRequestsResponseItemsItemPullRequest = {
	diff_url: null;
	html_url: null;
	patch_url: null;
};
declare type SearchIssuesAndPullRequestsResponseItemsItemLabelsItem = {
	color: string;
	id: number;
	name: string;
	node_id: string;
	url: string;
};
declare type SearchIssuesAndPullRequestsResponseItemsItem = {
	assignee: null | SearchIssuesAndPullRequestsResponseItemsItemUser;
	assignees: null | Array<SearchIssuesAndPullRequestsResponseItemsItemUser>;
	body: string;
	closed_at: null;
	comments: number;
	comments_url: string;
	created_at: string;
	events_url: string;
	html_url: string;
	id: number;
	labels: Array<SearchIssuesAndPullRequestsResponseItemsItemLabelsItem>;
	labels_url: string;
	milestone: null;
	node_id: string;
	number: number;
	pull_request: SearchIssuesAndPullRequestsResponseItemsItemPullRequest;
	repository_url: string;
	score: number;
	state: string;
	title: string;
	updated_at: string;
	url: string;
	user: SearchIssuesAndPullRequestsResponseItemsItemUser;
};
//#endregion
