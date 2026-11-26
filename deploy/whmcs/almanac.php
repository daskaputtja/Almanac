<?php
/**
 * Almanac for WHMCS
 *
 * Copy this file to your WHMCS install's includes/hooks/ folder and fill in
 * the three settings below. It:
 *
 *  - shows Almanac's summary of a customer (last watched, peak streams,
 *    devices, open flags, VPN use, playback) on each client's summary page
 *    in the WHMCS admin area, with a link to them in Almanac;
 *  - tells Almanac when WHMCS suspends, unsuspends, terminates or changes
 *    the package of a Silo service (non-payment, upgrades), so it's in the
 *    customer's notes and case file in Almanac.
 *
 * Suspensions approved in Almanac don't need this file: Almanac calls
 * WHMCS's API itself (Almanac → Settings → Billing portal → WHMCS).
 *
 * It never slows WHMCS down for long: every call to Almanac gives up after a
 * few seconds, and if Almanac can't be reached, WHMCS carries on as normal.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

// ----- Settings ----------------------------------------------------------------

/** Almanac's address, e.g. https://almanac.example.com */
const ALMANAC_URL = 'https://almanac.example.com';
/** The key from Almanac → Settings → Billing portal → Portal API (starts with alm_). */
const ALMANAC_KEY = 'alm_paste-your-key-here';
/** The WHMCS product IDs that are Silo plans (the same as in Almanac's WHMCS settings). */
const ALMANAC_SILO_PRODUCTS = [7];

// ----- Talking to Almanac ----------------------------------------------------------

/** Call Almanac's portal API. Returns the decoded JSON, or null if it couldn't be reached or answered with an error. */
function almanac_request(string $method, string $path, ?array $body = null): ?array
{
    if (strpos(ALMANAC_KEY, 'alm_') !== 0 || ALMANAC_KEY === 'alm_paste-your-key-here') {
        return null;
    }
    $ch = curl_init(rtrim(ALMANAC_URL, '/') . '/api/portal/v1' . $path);
    $headers = ['Authorization: Bearer ' . ALMANAC_KEY, 'Accept: application/json'];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_TIMEOUT => 5,
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($raw === false || $status < 200 || $status >= 300) {
        if ($status && $status !== 404) {
            logActivity('Almanac: request to ' . $path . ' failed with HTTP ' . $status);
        }
        return null;
    }
    $json = json_decode($raw, true);
    return is_array($json) ? $json : null;
}

/** Is this WHMCS product one of the Silo plans? */
function almanac_is_silo(int $pid): bool
{
    return in_array($pid, ALMANAC_SILO_PRODUCTS, true);
}

// ----- WHMCS → Almanac: what happened to a Silo service -----------------------------------

function almanac_report(array $vars, string $type): void
{
    $params = $vars['params'] ?? $vars;
    if (!almanac_is_silo((int) ($params['pid'] ?? 0))) {
        return;
    }
    // Suspensions Almanac asked for are already in its notes.
    $reason = (string) ($params['suspendreason'] ?? $vars['suspendreason'] ?? '');
    if ($type === 'suspended' && strpos($reason, 'Almanac:') === 0) {
        return;
    }
    $username = (string) ($params['username'] ?? '');
    $email = (string) ($params['clientsdetails']['email'] ?? '');
    $customer = $username !== '' ? ['username' => $username] : ['email' => $email];
    if (($customer['username'] ?? $customer['email'] ?? '') === '') {
        return;
    }
    $detail = 'WHMCS service #' . (int) ($params['serviceid'] ?? 0);
    if ($reason !== '') {
        $detail .= ': ' . $reason;
    }
    $result = almanac_request('POST', '/events', ['customer' => $customer, 'type' => $type, 'detail' => $detail]);
    // The service username didn't match a Silo account: try the client's email.
    if ($result === null && isset($customer['username']) && $email !== '') {
        almanac_request('POST', '/events', ['customer' => ['email' => $email], 'type' => $type, 'detail' => $detail]);
    }
}

add_hook('AfterModuleSuspend', 1, function (array $vars) {
    almanac_report($vars, 'suspended');
});

add_hook('AfterModuleUnsuspend', 1, function (array $vars) {
    almanac_report($vars, 'reactivated');
});

add_hook('AfterModuleTerminate', 1, function (array $vars) {
    almanac_report($vars, 'cancelled');
});

add_hook('AfterModuleChangePackage', 1, function (array $vars) {
    almanac_report($vars, 'plan_changed');
});

// ----- Almanac → WHMCS: the customer's summary on their admin page ---------------------------

add_hook('AdminAreaClientSummaryPage', 1, function (array $vars) {
    $clientId = (int) ($vars['userid'] ?? 0);
    if (!$clientId) {
        return '';
    }
    // Their Silo services' usernames first, then their email.
    $lookups = [];
    $products = localAPI('GetClientsProducts', ['clientid' => $clientId, 'limitnum' => 250]);
    foreach ($products['products']['product'] ?? [] as $service) {
        if (almanac_is_silo((int) $service['pid']) && !empty($service['username'])) {
            $lookups[] = 'username=' . rawurlencode($service['username']);
        }
    }
    $details = localAPI('GetClientsDetails', ['clientid' => $clientId]);
    $email = $details['client']['email'] ?? $details['email'] ?? '';
    if ($email !== '') {
        $lookups[] = 'email=' . rawurlencode($email);
    }

    $customer = null;
    foreach (array_unique($lookups) as $query) {
        $found = almanac_request('GET', '/customers?' . $query);
        if (!empty($found['customer'])) {
            $customer = $found['customer'];
            break;
        }
    }
    if ($customer === null) {
        return '';
    }
    return almanac_panel($customer);
});

function almanac_panel(array $c): string
{
    $e = function ($text) {
        return htmlspecialchars((string) $text, ENT_QUOTES, 'UTF-8');
    };
    $when = function ($iso) {
        if (!$iso) {
            return 'never';
        }
        $seconds = time() - strtotime($iso);
        if ($seconds < 3600) {
            return max(1, (int) round($seconds / 60)) . ' min ago';
        }
        if ($seconds < 86400) {
            return (int) round($seconds / 3600) . ' h ago';
        }
        return (int) round($seconds / 86400) . ' days ago';
    };
    $u = $c['usage'];
    $rows = [
        'Watching' => $c['watchingNow'] > 0 ? '<strong>Now</strong> (' . (int) $c['watchingNow'] . ' stream' . ($c['watchingNow'] == 1 ? '' : 's') . ')' : 'Last watched ' . $e($when($c['lastPlayedAt'])),
        'Last 30 days' => (int) $u['plays'] . ' plays, ' . $e($u['hoursWatched']) . ' hours on ' . (int) $u['activeDays'] . ' days',
        'Streams at once' => 'Peak ' . (int) $u['peakStreams'],
        'Devices' => (int) $u['devicesUsed'] . ' used, ' . (int) $u['devicesSignedIn'] . ' signed in' . ($c['mainDevice'] ? ' &middot; mostly ' . $e($c['mainDevice']) : ''),
        'Downloads' => (int) $u['downloads'] . ' (' . $e($u['downloadGb']) . ' GB)',
        'VPN' => $u['vpnShare'] === null ? 'Not known yet' : ((int) round($u['vpnShare'] * 100)) . '% of plays',
        'Playback' => $c['playback']['status'] === 'struggling' ? '<span style="color:#c0392b">Struggling</span>: ' . $e(implode('; ', $c['playback']['issues'])) : $e(ucfirst($c['playback']['status'])),
    ];
    $flags = '';
    foreach ($c['flags'] as $f) {
        if ($f['reviewed']) {
            continue;
        }
        $colour = $f['severity'] === 'high' ? '#c0392b' : ($f['severity'] === 'medium' ? '#d35400' : '#b7950b');
        $flags .= '<li><span style="color:' . $colour . ';font-weight:600">' . $e(['high' => 'Serious', 'medium' => 'Worth a look', 'low' => 'Minor'][$f['severity']] ?? $f['severity']) . '</span> ' . $e($f['headline']) . '</li>';
    }
    $html = '<div class="panel panel-default" style="margin-top:15px"><div class="panel-heading"><h3 class="panel-title">Almanac'
        . ($c['almanacUrl'] ? ' &middot; <a href="' . $e($c['almanacUrl']) . '" target="_blank" rel="noopener">Open in Almanac</a>' : '')
        . '</h3></div><div class="panel-body"><table class="table table-condensed" style="margin-bottom:0">';
    foreach ($rows as $label => $value) {
        $html .= '<tr><td style="width:160px;color:#777">' . $e($label) . '</td><td>' . $value . '</td></tr>';
    }
    $html .= '</table>';
    if ($flags !== '') {
        $html .= '<p style="margin:10px 0 4px;font-weight:600">Open flags</p><ul style="margin:0;padding-left:18px">' . $flags . '</ul>';
    }
    if (!empty($c['pendingSuspension'])) {
        $html .= '<p style="margin-top:10px;color:#d35400">A request to ' . $e($c['pendingSuspension']['action']) . ' this account is waiting for an admin in Almanac.</p>';
    }
    return $html . '</div></div>';
}
