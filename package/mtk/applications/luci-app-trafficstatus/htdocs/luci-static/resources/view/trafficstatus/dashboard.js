'use strict';
'require fs';
'require network';
'require poll';
'require view';

var ACTION = '/usr/libexec/trafficstatus-action';
var ZERO_MAC = '00:00:00:00:00:00';
var SAMPLE_SECONDS = 5;
var RATE_WINDOW_MS = 15000;
var CHART_WINDOW_MS = 15 * 60 * 1000;
var MIN_CHART_BPS = 1000 * 1000;
var CHART = {
	width: 960,
	height: 280,
	left: 68,
	right: 20,
	top: 22,
	bottom: 38
};

function number(value) {
	value = Number(value);
	return isFinite(value) && value >= 0 ? value : 0;
}

function normalizeMac(value) {
	value = String(value || '').toLowerCase();
	return /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(value) ? value : ZERO_MAC;
}

function formatBytes(value) {
	var units = [ 'B', 'KB', 'MB', 'GB', 'TB' ];
	var n = number(value);
	var i = 0;

	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}

	return (i ? n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) : Math.round(n)) + ' ' + units[i];
}

function formatRate(value) {
	var units = [ 'bps', 'Kbps', 'Mbps', 'Gbps' ];
	var n = number(value) * 8;
	var i = 0;

	while (n >= 1000 && i < units.length - 1) {
		n /= 1000;
		i++;
	}

	return (i ? n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) : Math.round(n)) + ' ' + units[i];
}

function formatPercent(value) {
	var n = Math.max(0, Math.min(number(value), 100));
	return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + '%';
}

function formatClock(value) {
	var date = new Date(value);

	try {
		return date.toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}
	catch (e) {
		return date.toLocaleTimeString();
	}
}

function niceRateMaximum(value) {
	var n = Math.max(number(value) * 8 * 1.08, MIN_CHART_BPS);
	var exponent = Math.floor(Math.log(n) / Math.LN10);
	var magnitude = Math.pow(10, exponent);
	var fraction = n / magnitude;
	var nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;

	return nice * magnitude / 8;
}

function svgElement(name, attrs) {
	var node = document.createElementNS('http://www.w3.org/2000/svg', name);
	for (var key in attrs)
		node.setAttribute(key, attrs[key]);
	return node;
}

function searchIcon() {
	var svg = svgElement('svg', {
		'class': 'trafficstatus-search-icon',
		'viewBox': '0 0 24 24',
		'width': '16',
		'height': '16',
		'fill': 'none',
		'stroke': 'currentColor',
		'stroke-width': '2',
		'stroke-linecap': 'round',
		'aria-hidden': 'true',
		'focusable': 'false'
	});

	svg.appendChild(svgElement('circle', { 'cx': '11', 'cy': '11', 'r': '7' }));
	svg.appendChild(svgElement('path', { 'd': 'm20 20-4-4' }));
	return svg;
}

function sortIcon() {
	var svg = svgElement('svg', {
		'class': 'trafficstatus-sort-icon',
		'viewBox': '0 0 12 16',
		'width': '12',
		'height': '16',
		'fill': 'none',
		'stroke': 'currentColor',
		'stroke-width': '1.5',
		'stroke-linecap': 'round',
		'stroke-linejoin': 'round',
		'aria-hidden': 'true',
		'focusable': 'false'
	});

	svg.appendChild(svgElement('path', { 'class': 'is-up', 'd': 'm3 6 3-3 3 3' }));
	svg.appendChild(svgElement('path', { 'class': 'is-down', 'd': 'm3 10 3 3 3-3' }));
	return svg;
}

function fieldIndex(columns) {
	var index = {};
	for (var i = 0; i < columns.length; i++)
		index[columns[i]] = i;
	return index;
}

function setText(node, value) {
	value = String(value);
	if (node && node.textContent !== value)
		node.textContent = value;
}

function setHidden(node, hidden) {
	if (!node)
		return;

	if (hidden)
		node.setAttribute('hidden', '');
	else
		node.removeAttribute('hidden');
}

function themeHasNeutralVariables() {
	var style = window.getComputedStyle(document.documentElement);

	return !!(style.getPropertyValue('--surface').trim() ||
		style.getPropertyValue('--background-color-high').trim());
}

function colorIsDark(value) {
	var match = String(value || '').match(/^rgba?\(([^)]+)\)$/i);
	if (!match)
		return null;

	var parts = match[1].match(/[\d.]+/g);
	if (!parts || parts.length < 3 || (parts.length > 3 && Number(parts[3]) === 0))
		return null;

	var luminance = 0;
	var weights = [ 0.2126, 0.7152, 0.0722 ];
	for (var i = 0; i < 3; i++) {
		var channel = Number(parts[i]) / 255;
		channel = channel <= 0.04045
			? channel / 12.92
			: Math.pow((channel + 0.055) / 1.055, 2.4);
		luminance += channel * weights[i];
	}

	return luminance < 0.35;
}

function pageBackgroundIsDark() {
	var candidates = [
		document.querySelector('.main-right'),
		document.body,
		document.documentElement
	];

	for (var i = 0; i < candidates.length; i++) {
		if (!candidates[i])
			continue;

		var dark = colorIsDark(window.getComputedStyle(candidates[i]).backgroundColor);
		if (dark !== null)
			return dark;
	}

	return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function loadStylesheet() {
	if (document.getElementById('trafficstatus-style'))
		return;

	var link = E('link', {
		'id': 'trafficstatus-style',
		'rel': 'stylesheet',
		'href': L.resource('view/trafficstatus/trafficstatus.css')
	});
	(document.head || document.getElementsByTagName('head')[0]).appendChild(link);
}

return view.extend({
	hostHints: null,
	snapshots: [],
	history: [],
	nodes: {},
	rowNodes: {},
	sortHeaders: {},
	model: null,
	error: null,
	query: '',
	sortKey: 'rate',
	sortDirection: 'desc',
	inFlight: false,
	requestSerial: 0,
	lastUpdated: 0,
	chartPoints: null,
	chartHoverIndex: null,

	load: function() {
		this.hostHints = null;
		this.snapshots = [];
		this.history = [];
		this.nodes = {};
		this.rowNodes = {};
		this.sortHeaders = {};
		this.model = null;
		this.error = null;
		this.query = '';
		this.sortKey = 'rate';
		this.sortDirection = 'desc';
		this.inFlight = false;
		this.requestSerial = 0;
		this.lastUpdated = 0;
		this.chartPoints = null;
		this.chartHoverIndex = null;

		return L.resolveDefault(network.getHostHints(), null).then(L.bind(function(hints) {
			this.hostHints = hints;
		}, this));
	},

	fetchSnapshot: function() {
		return fs.exec_direct(ACTION, [ 'snapshot' ], 'json').then(L.bind(function(data) {
			if (!data || !Array.isArray(data.columns) || !Array.isArray(data.data))
				throw new Error(_('Malformed traffic data'));

			return this.aggregate(data);
		}, this));
	},

	aggregate: function(data) {
		var index = fieldIndex(data.columns);
		var required = [ 'mac', 'ip', 'conns', 'rx_bytes', 'tx_bytes' ];
		var records = {};
		var totals = { rx: 0, tx: 0, connections: 0 };

		for (var i = 0; i < required.length; i++)
			if (index[required[i]] === undefined)
				throw new Error(_('Traffic data is missing the %s field').format(required[i]));

		for (var j = 0; j < data.data.length; j++) {
			var row = data.data[j];
			var mac = normalizeMac(row[index.mac]);
			var ip = String(row[index.ip] || '');
			var key = mac !== ZERO_MAC ? 'mac:' + mac : 'ip:' + (ip || 'unknown');
			var rec = records[key];

			if (!rec) {
				rec = records[key] = {
					key: key,
					mac: mac,
					ip: ip,
					ips: [],
					ipSet: {},
					rx: 0,
					tx: 0,
					connections: 0
				};
			}

			if (ip && !rec.ipSet[ip]) {
				rec.ipSet[ip] = true;
				rec.ips.push(ip);
				if (!rec.ip)
					rec.ip = ip;
			}

			rec.rx += number(row[index.rx_bytes]);
			rec.tx += number(row[index.tx_bytes]);
			rec.connections += number(row[index.conns]);
		}

		var clients = [];
		for (var recordKey in records) {
			var client = records[recordKey];
			delete client.ipSet;
			clients.push(client);
			totals.rx += client.rx;
			totals.tx += client.tx;
			totals.connections += client.connections;
		}

		clients.sort(function(a, b) {
			return (b.rx + b.tx) - (a.rx + a.tx);
		});

		return { clients: clients, totals: totals };
	},

	calculate: function(snapshot) {
		var wall = Date.now();
		var mono = window.performance && window.performance.now ? window.performance.now() : wall;
		var current = { t: wall, mono: mono, snapshot: snapshot };
		var baseline = null;
		var rates = { rx: 0, tx: 0, ready: false };
		var oldByKey = {};

		this.snapshots.push(current);
		while (this.snapshots.length > 1 && mono - this.snapshots[0].mono > CHART_WINDOW_MS + RATE_WINDOW_MS)
			this.snapshots.shift();

		for (var i = this.snapshots.length - 1; i >= 0; i--) {
			if (mono - this.snapshots[i].mono >= RATE_WINDOW_MS) {
				baseline = this.snapshots[i];
				break;
			}
		}

		if (baseline) {
			var elapsed = Math.max((mono - baseline.mono) / 1000, 1);

			for (var j = 0; j < baseline.snapshot.clients.length; j++) {
				var old = baseline.snapshot.clients[j];
				oldByKey[old.key] = old;
			}

			for (var k = 0; k < snapshot.clients.length; k++) {
				var client = snapshot.clients[k];
				var previous = oldByKey[client.key];

				client.rxRate = previous && client.rx >= previous.rx ? (client.rx - previous.rx) / elapsed : 0;
				client.txRate = previous && client.tx >= previous.tx ? (client.tx - previous.tx) / elapsed : 0;
				rates.rx += client.rxRate;
				rates.tx += client.txRate;
			}

			rates.ready = true;
		}
		else {
			for (var n = 0; n < snapshot.clients.length; n++) {
				snapshot.clients[n].rxRate = 0;
				snapshot.clients[n].txRate = 0;
			}
		}

		this.history.push({
			t: wall,
			mono: mono,
			rx: rates.rx,
			tx: rates.tx
		});

		while (this.history.length > 1 && mono - this.history[0].mono > CHART_WINDOW_MS)
			this.history.shift();

		var active = 0;
		for (var m = 0; m < snapshot.clients.length; m++) {
			var item = snapshot.clients[m];
			item.totalRate = item.rxRate + item.txRate;
			item.totalBytes = item.rx + item.tx;
			if (item.totalRate > 0)
				active++;
		}

		return {
			clients: snapshot.clients,
			totals: snapshot.totals,
			rates: rates,
			active: active,
			updated: wall
		};
	},

	getName: function(client) {
		if (this.hostHints && client.mac !== ZERO_MAC) {
			var name = this.hostHints.getHostnameByMACAddr(client.mac);
			if (name)
				return name;
		}

		if (this.hostHints) {
			for (var i = 0; i < client.ips.length; i++) {
				var ip = client.ips[i];
				var resolved = ip.indexOf(':') >= 0
					? this.hostHints.getHostnameByIP6Addr(ip)
					: this.hostHints.getHostnameByIPAddr(ip);

				if (resolved)
					return resolved;
			}
		}

		if (client.ip)
			return client.ip;

		return client.mac !== ZERO_MAC ? client.mac.toUpperCase() : _('Unknown device');
	},

	prepareModel: function(model) {
		var totalRate = model.rates.rx + model.rates.tx;

		for (var i = 0; i < model.clients.length; i++) {
			var client = model.clients[i];
			client.name = this.getName(client);
			client.share = totalRate > 0 ? client.totalRate / totalRate * 100 : 0;
			client.searchText = [
				client.name,
				client.mac !== ZERO_MAC ? client.mac : '',
				client.ips.join(' ')
			].join(' ').toLowerCase();
		}

		return model;
	},

	setStatus: function(text, state) {
		if (!this.nodes.status)
			return;

		setText(this.nodes.statusText, text);
		this.nodes.status.className = 'trafficstatus-status is-' + state;
	},

	setUpdatedText: function(failed) {
		if (!this.nodes.updated)
			return;

		if (!this.lastUpdated)
			setText(this.nodes.updated, _('No data yet'));
		else if (failed)
			setText(this.nodes.updated, _('Last update %s').format(formatClock(this.lastUpdated)));
		else
			setText(this.nodes.updated, _('Updated %s').format(formatClock(this.lastUpdated)));
	},

	renderStats: function() {
		if (!this.model)
			return;

		var rates = this.model.rates;
		var totals = this.model.totals;

		setText(this.nodes.rxRate, rates.ready ? formatRate(rates.rx) : '--');
		setText(this.nodes.txRate, rates.ready ? formatRate(rates.tx) : '--');
		setText(this.nodes.total, formatBytes(totals.rx + totals.tx));
		setText(this.nodes.clients, this.model.active);
	},

	getVisibleClients: function() {
		if (!this.model)
			return [];

		var query = this.query.replace(/^\s+|\s+$/g, '').toLowerCase();
		var clients = this.model.clients.filter(function(client) {
			return !query || client.searchText.indexOf(query) >= 0;
		});
		var key = this.sortKey;
		var direction = this.sortDirection === 'asc' ? 1 : -1;

		clients.sort(function(a, b) {
			var av;
			var bv;

			switch (key) {
			case 'name':
				av = a.name.toLowerCase();
				bv = b.name.toLowerCase();
				break;
			case 'rxRate':
				av = a.rxRate;
				bv = b.rxRate;
				break;
			case 'txRate':
				av = a.txRate;
				bv = b.txRate;
				break;
			case 'rx':
				av = a.rx;
				bv = b.rx;
				break;
			case 'tx':
				av = a.tx;
				bv = b.tx;
				break;
			default:
				av = a.totalRate;
				bv = b.totalRate;
			}

			if (typeof av === 'string') {
				var compared = av.localeCompare(bv);
				if (compared)
					return compared * direction;
			}
			else if (av !== bv) {
				return (av - bv) * direction;
			}

			return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
		});

		return clients;
	},

	updateSortHeaders: function() {
		for (var key in this.sortHeaders) {
			var entry = this.sortHeaders[key];
			var selected = key === this.sortKey;

			entry.th.removeAttribute('aria-sort');
			entry.button.className = 'trafficstatus-sort' + (selected
				? ' is-sorted is-' + this.sortDirection
				: '');

			if (selected)
				entry.th.setAttribute('aria-sort', this.sortDirection === 'asc' ? 'ascending' : 'descending');
		}
	},

	handleSort: function(key) {
		if (this.sortKey === key)
			this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
		else {
			this.sortKey = key;
			this.sortDirection = key === 'name' ? 'asc' : 'desc';
		}

		this.renderClients();
	},

	createClientRow: function(client) {
		var deviceLabel = _('Client');
		var downLabel = _('Download rate');
		var upLabel = _('Upload rate');
		var shareLabel = _('Traffic share');
		var totalDownLabel = _('Total down');
		var totalUpLabel = _('Total up');
		var name = E('strong', { 'class': 'trafficstatus-device-name' });
		var meta = E('span', { 'class': 'trafficstatus-device-meta' });
		var rxRate = E('span', { 'class': 'trafficstatus-value' });
		var txRate = E('span', { 'class': 'trafficstatus-value' });
		var sharePercent = E('span', { 'class': 'trafficstatus-share-percent' });
		var rxTotal = E('span', { 'class': 'trafficstatus-value' });
		var txTotal = E('span', { 'class': 'trafficstatus-value' });
		var row = E('tr', { 'class': 'tr trafficstatus-client-row' }, [
			E('td', { 'class': 'td trafficstatus-device-cell', 'data-title': deviceLabel }, [
				E('div', { 'class': 'trafficstatus-device' }, [
					name,
					meta
				])
			]),
			E('td', { 'class': 'td right trafficstatus-rate-cell is-download', 'data-title': downLabel }, rxRate),
			E('td', { 'class': 'td right trafficstatus-rate-cell is-upload', 'data-title': upLabel }, txRate),
			E('td', { 'class': 'td right trafficstatus-share-cell', 'data-title': shareLabel }, sharePercent),
			E('td', { 'class': 'td right trafficstatus-total-cell', 'data-title': totalDownLabel }, rxTotal),
			E('td', { 'class': 'td right trafficstatus-total-cell', 'data-title': totalUpLabel }, txTotal)
		]);

		var entry = {
			row: row,
			name: name,
			meta: meta,
			rxRate: rxRate,
			txRate: txRate,
			sharePercent: sharePercent,
			rxTotal: rxTotal,
			txTotal: txTotal
		};

		this.rowNodes[client.key] = entry;
		return entry;
	},

	updateClientRow: function(entry, client) {
		var meta = client.ips.slice();

		if (client.mac !== ZERO_MAC)
			meta.push(client.mac.toUpperCase());
		if (!meta.length)
			meta.push(_('Unknown address'));

		var ready = this.model.rates.ready;

		setText(entry.name, client.name);
		setText(entry.meta, meta.join(' \u00b7 '));
		setText(entry.rxRate, ready ? formatRate(client.rxRate) : '--');
		setText(entry.txRate, ready ? formatRate(client.txRate) : '--');
		setText(entry.sharePercent, ready ? formatPercent(client.share) : '--');
		setText(entry.rxTotal, formatBytes(client.rx));
		setText(entry.txTotal, formatBytes(client.tx));

		entry.sharePercent.setAttribute('aria-label', _('%s traffic share').format(client.name));
		entry.row.className = 'tr trafficstatus-client-row';
	},

	reconcileRows: function(rows) {
		var tbody = this.nodes.tbody;
		var cursor = tbody.firstChild;

		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];

			if (row === cursor)
				cursor = cursor.nextSibling;
			else
				tbody.insertBefore(row, cursor);
		}

		while (cursor) {
			var next = cursor.nextSibling;
			tbody.removeChild(cursor);
			cursor = next;
		}
	},

	renderClients: function() {
		if (!this.nodes.tbody)
			return;

		this.updateSortHeaders();

		if (!this.model) {
			setText(this.nodes.resultCount, '');
			setText(this.nodes.emptyText, this.error ? _('Statistics unavailable') : _('Waiting for traffic data...'));
			this.reconcileRows([ this.nodes.emptyRow ]);
			return;
		}

		var clients = this.getVisibleClients();
		var allKeys = {};
		var rows = [];

		for (var i = 0; i < this.model.clients.length; i++)
			allKeys[this.model.clients[i].key] = true;

		for (var key in this.rowNodes) {
			if (!allKeys[key]) {
				if (this.rowNodes[key].row.parentNode)
					this.rowNodes[key].row.parentNode.removeChild(this.rowNodes[key].row);
				delete this.rowNodes[key];
			}
		}

		for (var j = 0; j < clients.length; j++) {
			var client = clients[j];
			var entry = this.rowNodes[client.key] || this.createClientRow(client);
			this.updateClientRow(entry, client);
			rows.push(entry.row);
		}

		if (!clients.length) {
			setText(this.nodes.emptyText, this.model.clients.length
				? _('No devices match your search.')
				: _('No traffic recorded yet.'));
			rows.push(this.nodes.emptyRow);
		}

		setText(this.nodes.resultCount, this.query
			? _('Showing %d of %d devices').format(clients.length, this.model.clients.length)
			: _('%d devices').format(this.model.clients.length));
		this.reconcileRows(rows);
	},

	setupChart: function() {
		var plotWidth = CHART.width - CHART.left - CHART.right;
		var plotHeight = CHART.height - CHART.top - CHART.bottom;
		var svg = svgElement('svg', {
			'class': 'trafficstatus-chart-svg',
			'viewBox': '0 0 ' + CHART.width + ' ' + CHART.height,
			'preserveAspectRatio': 'xMidYMid meet',
			'role': 'img',
			'aria-label': _('Traffic rate over the current session')
		});
		var defs = svgElement('defs', {});
		var gradient = function(id, state) {
			var node = svgElement('linearGradient', {
				'id': id,
				'x1': '0',
				'y1': '0',
				'x2': '0',
				'y2': '1'
			});

			node.appendChild(svgElement('stop', {
				'class': 'trafficstatus-gradient-stop is-' + state + ' is-start',
				'offset': '0%'
			}));
			node.appendChild(svgElement('stop', {
				'class': 'trafficstatus-gradient-stop is-' + state + ' is-end',
				'offset': '100%'
			}));
			return node;
		};

		defs.appendChild(gradient('trafficstatus-download-fill', 'download'));
		defs.appendChild(gradient('trafficstatus-upload-fill', 'upload'));

		var scaleGroup = svgElement('g', { 'class': 'trafficstatus-scale-group', 'hidden': '' });
		var labels = [];
		var guideFractions = [ 1, 0.5, 0 ];

		for (var i = 0; i < guideFractions.length; i++) {
			var fraction = guideFractions[i];
			var gy = CHART.top + plotHeight * (1 - fraction);

			if (fraction > 0)
				scaleGroup.appendChild(svgElement('line', {
					'x1': CHART.left,
					'y1': gy,
					'x2': CHART.width - CHART.right,
					'y2': gy,
					'class': 'trafficstatus-grid'
				}));

			var label = svgElement('text', {
				'x': CHART.left - 10,
				'y': gy + 4,
				'class': 'trafficstatus-axis-label',
				'text-anchor': 'end'
			});
			labels.push(label);
			scaleGroup.appendChild(label);
		}

		var timeGroup = svgElement('g', { 'class': 'trafficstatus-time-group', 'hidden': '' });
		var xLabels = [];
		for (var xIndex = 0; xIndex < 3; xIndex++) {
			var x = CHART.left + plotWidth * xIndex / 2;
			var xLabel = svgElement('text', {
				'x': x,
				'y': CHART.height - 10,
				'class': 'trafficstatus-axis-label trafficstatus-time-label',
				'text-anchor': xIndex === 0 ? 'start' : xIndex === 2 ? 'end' : 'middle'
			});
			xLabels.push(xLabel);
			timeGroup.appendChild(xLabel);
		}

		var axis = svgElement('line', {
			'x1': CHART.left,
			'y1': CHART.top + plotHeight,
			'x2': CHART.width - CHART.right,
			'y2': CHART.top + plotHeight,
			'class': 'trafficstatus-axis'
		});
		var rxArea = svgElement('path', {
			'class': 'trafficstatus-area is-download',
			'fill': 'url(#trafficstatus-download-fill)',
			'hidden': ''
		});
		var txArea = svgElement('path', {
			'class': 'trafficstatus-area is-upload',
			'fill': 'url(#trafficstatus-upload-fill)',
			'hidden': ''
		});
		var rxPath = svgElement('path', { 'class': 'trafficstatus-line is-download', 'hidden': '' });
		var txPath = svgElement('path', { 'class': 'trafficstatus-line is-upload', 'hidden': '' });
		var latestRx = svgElement('circle', { 'r': '3.5', 'class': 'trafficstatus-point is-download', 'hidden': '' });
		var latestTx = svgElement('circle', { 'r': '3.5', 'class': 'trafficstatus-point is-upload', 'hidden': '' });
		var crosshair = svgElement('line', {
			'y1': CHART.top,
			'y2': CHART.top + plotHeight,
			'class': 'trafficstatus-crosshair',
			'hidden': ''
		});
		var hoverRx = svgElement('circle', { 'r': '5', 'class': 'trafficstatus-hover-point is-download', 'hidden': '' });
		var hoverTx = svgElement('circle', { 'r': '5', 'class': 'trafficstatus-hover-point is-upload', 'hidden': '' });
		var overlay = svgElement('rect', {
			'x': CHART.left,
			'y': CHART.top,
			'width': plotWidth,
			'height': plotHeight,
			'class': 'trafficstatus-chart-overlay',
			'tabindex': '0',
			'role': 'application',
			'aria-label': _('Use the left and right arrow keys to inspect traffic samples')
		});

		svg.appendChild(defs);
		svg.appendChild(scaleGroup);
		svg.appendChild(timeGroup);
		svg.appendChild(axis);
		svg.appendChild(rxArea);
		svg.appendChild(txArea);
		svg.appendChild(rxPath);
		svg.appendChild(txPath);
		svg.appendChild(latestRx);
		svg.appendChild(latestTx);
		svg.appendChild(crosshair);
		svg.appendChild(hoverRx);
		svg.appendChild(hoverTx);
		svg.appendChild(overlay);

		var tooltipTime = E('strong', { 'class': 'trafficstatus-tooltip-time' });
		var tooltipRx = E('span', { 'class': 'trafficstatus-tooltip-value is-download' });
		var tooltipTx = E('span', { 'class': 'trafficstatus-tooltip-value is-upload' });
		var tooltip = E('div', { 'class': 'trafficstatus-tooltip', 'hidden': '', 'role': 'status' }, [
			tooltipTime,
			E('span', { 'class': 'trafficstatus-tooltip-row' }, [
				E('i', { 'class': 'is-download', 'aria-hidden': 'true' }),
				E('span', {}, _('Download')),
				tooltipRx
			]),
			E('span', { 'class': 'trafficstatus-tooltip-row' }, [
				E('i', { 'class': 'is-upload', 'aria-hidden': 'true' }),
				E('span', {}, _('Upload')),
				tooltipTx
			])
		]);
		var state = E('div', { 'class': 'trafficstatus-chart-state' }, _('Waiting for traffic data...'));

		this.nodes.chart.appendChild(svg);
		this.nodes.chart.appendChild(tooltip);
		this.nodes.chart.appendChild(state);
		this.nodes.chartSvg = svg;
		this.nodes.chartScaleGroup = scaleGroup;
		this.nodes.chartTimeGroup = timeGroup;
		this.nodes.chartAxis = axis;
		this.nodes.chartGridLabels = labels;
		this.nodes.chartTimeLabels = xLabels;
		this.nodes.chartRxArea = rxArea;
		this.nodes.chartTxArea = txArea;
		this.nodes.chartRxPath = rxPath;
		this.nodes.chartTxPath = txPath;
		this.nodes.chartLatestRx = latestRx;
		this.nodes.chartLatestTx = latestTx;
		this.nodes.chartCrosshair = crosshair;
		this.nodes.chartHoverRx = hoverRx;
		this.nodes.chartHoverTx = hoverTx;
		this.nodes.chartOverlay = overlay;
		this.nodes.chartTooltip = tooltip;
		this.nodes.chartTooltipTime = tooltipTime;
		this.nodes.chartTooltipRx = tooltipRx;
		this.nodes.chartTooltipTx = tooltipTx;
		this.nodes.chartState = state;

		overlay.addEventListener('mousemove', L.bind(this.handleChartPointer, this));
		overlay.addEventListener('mouseleave', L.bind(this.hideChartTooltip, this));
		overlay.addEventListener('touchstart', L.bind(this.handleChartPointer, this), { passive: true });
		overlay.addEventListener('touchmove', L.bind(this.handleChartPointer, this), { passive: true });
		overlay.addEventListener('keydown', L.bind(this.handleChartKey, this));
	},

	updateChartAspect: function() {
		if (!this.nodes.chart || !this.nodes.chartSvg)
			return;

		var bounds = this.nodes.chart.getBoundingClientRect();
		if (!bounds.width || !bounds.height)
			return;

		var viewportRatio = bounds.width / bounds.height;
		var viewBoxRatio = CHART.width / CHART.height;
		this.nodes.chartSvg.setAttribute('preserveAspectRatio', viewportRatio > viewBoxRatio
			? 'none'
			: 'xMidYMid meet');
	},

	setChartState: function(text, state, visible) {
		setText(this.nodes.chartState, text);
		this.nodes.chartState.className = 'trafficstatus-chart-state' + (state ? ' is-' + state : '');
		setHidden(this.nodes.chartState, !visible);
		this.nodes.chart.classList.toggle('has-state', visible);
	},

	setChartDataVisible: function(visible) {
		var nodes = [
			this.nodes.chartScaleGroup,
			this.nodes.chartTimeGroup,
			this.nodes.chartAxis,
			this.nodes.chartRxArea,
			this.nodes.chartTxArea,
			this.nodes.chartRxPath,
			this.nodes.chartTxPath,
			this.nodes.chartLatestRx,
			this.nodes.chartLatestTx
		];

		for (var i = 0; i < nodes.length; i++)
			setHidden(nodes[i], !visible);

		this.nodes.chartOverlay.setAttribute('aria-disabled', visible ? 'false' : 'true');
		this.nodes.chartOverlay.setAttribute('tabindex', visible ? '0' : '-1');

		if (!visible) {
			this.nodes.chartRxArea.setAttribute('d', '');
			this.nodes.chartTxArea.setAttribute('d', '');
			this.nodes.chartRxPath.setAttribute('d', '');
			this.nodes.chartTxPath.setAttribute('d', '');
			this.chartPoints = null;
			this.hideChartTooltip();
		}
	},

	renderChart: function() {
		this.updateChartAspect();

		if (!this.history.length) {
			this.setChartDataVisible(false);
			this.setChartState(_('Waiting for traffic data...'), '', true);
			return;
		}
		if (this.model && !this.model.rates.ready) {
			this.setChartDataVisible(false);
			this.setChartState(_('Collecting baseline...'), 'warmup', true);
			return;
		}

		var plotWidth = CHART.width - CHART.left - CHART.right;
		var plotHeight = CHART.height - CHART.top - CHART.bottom;
		var firstSample = this.history[0];
		var lastSample = this.history[this.history.length - 1];
		var firstMono = firstSample.mono - (this.history.length === 1 ? SAMPLE_SECONDS * 1000 : 0);
		var span = Math.max(lastSample.mono - firstMono, 1);
		var peak = 0;

		for (var i = 0; i < this.history.length; i++)
			peak = Math.max(peak, this.history[i].rx, this.history[i].tx);

		if (peak <= 0) {
			this.setChartDataVisible(false);
			this.setChartState(_('No traffic in this window'), 'empty', true);
			return;
		}

		var max = niceRateMaximum(peak);

		setText(this.nodes.chartGridLabels[0], formatRate(max));
		setText(this.nodes.chartGridLabels[1], formatRate(max / 2));
		setText(this.nodes.chartGridLabels[2], formatRate(0));

		var points = function(key) {
			var result = [];
			for (var index = 0; index < this.history.length; index++) {
				var sample = this.history[index];
				var x = CHART.left + (sample.mono - firstMono) / span * plotWidth;
				var y = CHART.top + plotHeight - sample[key] / max * plotHeight;
				result.push({ x: x, y: y });
			}
			return result;
		}.bind(this);
		var linePath = function(list) {
			var d = '';
			for (var point = 0; point < list.length; point++)
				d += (point ? ' L ' : 'M ') + list[point].x.toFixed(2) + ' ' + list[point].y.toFixed(2);
			return d;
		};
		var areaPath = function(list) {
			if (!list.length)
				return '';

			var baseline = CHART.top + plotHeight;
			return linePath(list) +
				' L ' + list[list.length - 1].x.toFixed(2) + ' ' + baseline.toFixed(2) +
				' L ' + list[0].x.toFixed(2) + ' ' + baseline.toFixed(2) + ' Z';
		};
		var rx = points('rx');
		var tx = points('tx');
		var latestIndex = this.history.length - 1;
		var midpoint = Math.round((firstSample.t + lastSample.t) / 2);

		this.nodes.chartRxArea.setAttribute('d', areaPath(rx));
		this.nodes.chartTxArea.setAttribute('d', areaPath(tx));
		this.nodes.chartRxPath.setAttribute('d', linePath(rx));
		this.nodes.chartTxPath.setAttribute('d', linePath(tx));
		this.nodes.chartLatestRx.setAttribute('cx', rx[latestIndex].x);
		this.nodes.chartLatestRx.setAttribute('cy', rx[latestIndex].y);
		this.nodes.chartLatestTx.setAttribute('cx', tx[latestIndex].x);
		this.nodes.chartLatestTx.setAttribute('cy', tx[latestIndex].y);
		setText(this.nodes.chartTimeLabels[0], formatClock(firstSample.t));
		setText(this.nodes.chartTimeLabels[1], formatClock(midpoint));
		setText(this.nodes.chartTimeLabels[2], formatClock(lastSample.t));
		this.chartPoints = { rx: rx, tx: tx };
		this.setChartDataVisible(true);
		this.setChartState('', '', false);

		if (this.chartHoverIndex !== null)
			this.showChartTooltip(Math.min(this.chartHoverIndex, latestIndex));
	},

	handleChartPointer: function(event) {
		if (!this.chartPoints || !this.history.length)
			return;

		var source = event.touches && event.touches.length ? event.touches[0] : event;
		var bounds = this.nodes.chartOverlay.getBoundingClientRect();
		var pointerX = (source.clientX - bounds.left) / Math.max(bounds.width, 1) *
			(CHART.width - CHART.left - CHART.right) + CHART.left;
		var nearest = 0;
		var distance = Infinity;

		for (var i = 0; i < this.chartPoints.rx.length; i++) {
			var current = Math.abs(this.chartPoints.rx[i].x - pointerX);
			if (current < distance) {
				distance = current;
				nearest = i;
			}
		}

		this.showChartTooltip(nearest);
	},

	handleChartKey: function(event) {
		if (!this.history.length)
			return;

		var last = this.history.length - 1;
		var index = this.chartHoverIndex === null ? last : this.chartHoverIndex;

		if (event.key === 'ArrowLeft' || event.key === 'Left')
			index = Math.max(index - 1, 0);
		else if (event.key === 'ArrowRight' || event.key === 'Right')
			index = Math.min(index + 1, last);
		else if (event.key === 'Home')
			index = 0;
		else if (event.key === 'End')
			index = last;
		else if (event.key === 'Escape' || event.key === 'Esc') {
			this.hideChartTooltip();
			return;
		}
		else {
			return;
		}

		event.preventDefault();
		this.showChartTooltip(index);
	},

	showChartTooltip: function(index) {
		if (!this.chartPoints || !this.history[index])
			return;

		var sample = this.history[index];
		var rx = this.chartPoints.rx[index];
		var tx = this.chartPoints.tx[index];
		var left = rx.x / CHART.width * 100;

		this.chartHoverIndex = index;
		this.nodes.chartCrosshair.setAttribute('x1', rx.x);
		this.nodes.chartCrosshair.setAttribute('x2', rx.x);
		this.nodes.chartHoverRx.setAttribute('cx', rx.x);
		this.nodes.chartHoverRx.setAttribute('cy', rx.y);
		this.nodes.chartHoverTx.setAttribute('cx', tx.x);
		this.nodes.chartHoverTx.setAttribute('cy', tx.y);
		setText(this.nodes.chartTooltipTime, formatClock(sample.t));
		setText(this.nodes.chartTooltipRx, formatRate(sample.rx));
		setText(this.nodes.chartTooltipTx, formatRate(sample.tx));
		this.nodes.chartTooltip.style.left = left.toFixed(2) + '%';
		this.nodes.chartTooltip.className = 'trafficstatus-tooltip' + (left < 24
			? ' is-left'
			: left > 76 ? ' is-right' : '');
		setHidden(this.nodes.chartCrosshair, false);
		setHidden(this.nodes.chartHoverRx, false);
		setHidden(this.nodes.chartHoverTx, false);
		setHidden(this.nodes.chartTooltip, false);
	},

	hideChartTooltip: function() {
		this.chartHoverIndex = null;
		setHidden(this.nodes.chartCrosshair, true);
		setHidden(this.nodes.chartHoverRx, true);
		setHidden(this.nodes.chartHoverTx, true);
		setHidden(this.nodes.chartTooltip, true);
	},

	refresh: function() {
		if (this.inFlight)
			return Promise.resolve();

		this.inFlight = true;
		var serial = ++this.requestSerial;
		if (this.nodes.root)
			this.nodes.root.classList.add('is-refreshing');

		return this.fetchSnapshot().then(L.bind(function(snapshot) {
			if (serial !== this.requestSerial)
				return;

			this.model = this.prepareModel(this.calculate(snapshot));
			this.error = null;
			this.lastUpdated = this.model.updated;
			this.renderStats();
			this.renderClients();
			this.renderChart();
			this.setStatus(this.model.rates.ready ? _('Live') : _('Collecting baseline...'), this.model.rates.ready ? 'ok' : 'warmup');
			this.setUpdatedText(false);
		}, this), L.bind(function(err) {
			if (serial !== this.requestSerial)
				return;

			this.error = err;
			this.setStatus(_('Statistics unavailable'), 'error');
			this.setUpdatedText(true);
			this.renderClients();
			if (!this.model)
				this.setChartState(_('Unable to read traffic statistics'), 'error', true);
		}, this)).finally(L.bind(function() {
			this.inFlight = false;
			if (this.nodes.root)
				this.nodes.root.classList.remove('is-refreshing');
		}, this));
	},

	createSortHeader: function(key, label, className) {
		var button = E('button', {
			'type': 'button',
			'class': 'trafficstatus-sort',
			'title': _('Sort by %s').format(label),
			'click': L.bind(this.handleSort, this, key)
		}, [ E('span', {}, label), sortIcon() ]);
		var th = E('th', {
			'class': 'th ' + (className || ''),
			'scope': 'col'
		}, button);

		this.sortHeaders[key] = { th: th, button: button };
		return th;
	},

	render: function() {
		loadStylesheet();

		var stat = function(title, id, value, state) {
			return E('div', { 'class': 'trafficstatus-stat is-' + state }, [
				E('dt', {}, title),
				E('dd', { 'id': id }, value)
			]);
		};
		var searchInput = E('input', {
			'class': 'trafficstatus-search-input',
			'type': 'search',
			'placeholder': _('Search by device, IP or MAC'),
			'autocomplete': 'off',
			'spellcheck': 'false',
			'aria-label': _('Search by device, IP or MAC')
		});
		var search = E('label', { 'class': 'trafficstatus-search' }, [
			E('span', { 'class': 'trafficstatus-sr-only' }, _('Search clients')),
			searchIcon(),
			searchInput
		]);
		var resultCount = E('span', { 'class': 'trafficstatus-result-count', 'aria-live': 'polite' });
		var updated = E('span', { 'class': 'trafficstatus-updated' }, _('No data yet'));
		var statusText = E('span', {}, _('Starting...'));
		var status = E('span', {
			'class': 'trafficstatus-status is-warmup',
			'role': 'status',
			'aria-live': 'polite'
		}, [
			E('i', { 'aria-hidden': 'true' }),
			statusText
		]);
		var chart = E('div', { 'class': 'trafficstatus-chart', 'id': 'trafficstatus-chart' });
		var emptyText = E('span', {}, _('Waiting for traffic data...'));
		var emptyRow = E('tr', { 'class': 'trafficstatus-empty-row' }, [
			E('td', { 'colspan': '6' }, emptyText)
		]);
		var tbody = E('tbody', {}, emptyRow);
		var table = E('table', { 'class': 'trafficstatus-table', 'aria-label': _('Client traffic table') }, [
			E('thead', {}, E('tr', {}, [
				this.createSortHeader('name', _('Client'), ''),
				this.createSortHeader('rxRate', _('Download rate'), 'right'),
				this.createSortHeader('txRate', _('Upload rate'), 'right'),
				this.createSortHeader('rate', _('Traffic share'), ''),
				this.createSortHeader('rx', _('Total down'), 'right'),
				this.createSortHeader('tx', _('Total up'), 'right')
			])),
			tbody
		]);
		var rootClass = 'cbi-map trafficstatus-page';
		if (themeHasNeutralVariables())
			rootClass += ' has-theme-neutrals';
		if (pageBackgroundIsDark())
			rootClass += ' is-dark-theme';
		var root = E('div', { 'class': rootClass }, [
			E('header', { 'class': 'trafficstatus-heading' }, [
				E('h2', { 'name': 'content' }, _('Traffic Status')),
				E('div', { 'class': 'trafficstatus-heading-state' }, [ status, updated ])
			]),
			E('dl', { 'class': 'trafficstatus-stats' }, [
				stat(_('Download rate'), 'trafficstatus-rx-rate', '--', 'download'),
				stat(_('Upload rate'), 'trafficstatus-tx-rate', '--', 'upload'),
				stat(_('Recorded traffic'), 'trafficstatus-total', '0 B', 'traffic'),
				stat(_('Active clients'), 'trafficstatus-clients', '0', 'clients')
			]),
			E('section', { 'class': 'trafficstatus-section' }, [
				E('div', { 'class': 'trafficstatus-section-heading' }, [
					E('h3', {}, _('Live rate')),
					E('div', { 'class': 'trafficstatus-legend', 'aria-label': _('Chart legend') }, [
						E('span', {}, [ E('i', { 'class': 'is-download', 'aria-hidden': 'true' }), _('Download') ]),
						E('span', {}, [ E('i', { 'class': 'is-upload', 'aria-hidden': 'true' }), _('Upload') ])
					])
				]),
				chart
			]),
			E('section', { 'class': 'trafficstatus-section trafficstatus-clients-section' }, [
				E('div', { 'class': 'trafficstatus-section-heading trafficstatus-client-heading' }, [
					E('span', { 'class': 'trafficstatus-title-line' }, [
						E('h3', {}, _('Clients')),
						resultCount
					]),
					search
				]),
				E('div', { 'class': 'trafficstatus-table-shell' }, table)
			])
		]);

		this.nodes = {
			root: root,
			status: status,
			statusText: statusText,
			updated: updated,
			rxRate: root.querySelector('#trafficstatus-rx-rate'),
			txRate: root.querySelector('#trafficstatus-tx-rate'),
			total: root.querySelector('#trafficstatus-total'),
			clients: root.querySelector('#trafficstatus-clients'),
			chart: chart,
			search: searchInput,
			resultCount: resultCount,
			tbody: tbody,
			emptyRow: emptyRow,
			emptyText: emptyText
		};

		searchInput.addEventListener('input', L.bind(function(event) {
			this.query = event.target.value || '';
			this.renderClients();
		}, this));
		searchInput.addEventListener('keydown', L.bind(function(event) {
			if ((event.key === 'Escape' || event.key === 'Esc') && searchInput.value) {
				searchInput.value = '';
				this.query = '';
				this.renderClients();
			}
		}, this));

		this.setupChart();
		window.addEventListener('resize', L.bind(this.updateChartAspect, this));
		this.updateSortHeaders();
		poll.add(L.bind(this.refresh, this), SAMPLE_SECONDS);
		this.refresh();
		return root;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
