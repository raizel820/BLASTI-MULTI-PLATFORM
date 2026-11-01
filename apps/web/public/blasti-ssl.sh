#!/usr/bin/env bash
# ====================================================================
# BLASTI — ONE-SHOT HTTPS/SSL ENABLER  (run ON the VPS as root)
# ====================================================================
# Grants automatic HTTPS certificates for BOTH:
#     •  blastidz.online            (apex — full app + API)
#     •  www.blastidz.online        (own auto-TLS certificate +
#                                    308 redirect to the apex)
# ...and does every app-side update that must accompany it:
#     • SITE_ADDRESS gains https://<domain> (raw-IP door preserved)
#     • CORS_ORIGIN / ALLOWED_ORIGINS gain the apex + www origins
#     • the public gateway config is re-rendered from the repo
#       template (or patched in place when the template is absent),
#       validated, and the gateway + api services restarted
#
# Designed for the manual step the user runs from Windows PowerShell:
#     .\blasti-ssl.ps1                      (launches this over ssh)
# or directly:
#     ssh root@129.151.242.219 "bash /opt/blasti/scripts/blasti-ssl.sh"
#
# Safe to re-run at any time — every step is idempotent. A gateway
# config backup is written before anything changes.
#
# Usage:
#   sudo bash blasti-ssl.sh               # default domain: blastidz.online
#   sudo bash blasti-ssl.sh my.domain.tld # any other domain
#   sudo bash blasti-ssl.sh --check       # verify only, change nothing
# ====================================================================
set -euo pipefail

DEFAULT_DOMAIN="blastidz.online"
REPO_DIR="${BLASTI_REPO_DIR:-/opt/blasti}"
ENV_FILE="${BLASTI_ENV_FILE:-/etc/blasti/blasti.env}"
CADDYFILE="${BLASTI_CADDYFILE:-/etc/caddy/Caddyfile}"
CADDY_BIN="${BLASTI_CADDY_BIN:-caddy}"
SYSTEMCTL="${BLASTI_SYSTEMCTL:-systemctl}"
CURL="${BLASTI_CURL:-curl}"
TEMPLATE="$REPO_DIR/ops/Caddyfile"

log()  { printf '\033[1;35m[ssl]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[FAIL ]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- helpers (same semantics as deploy-oracle-vps.sh) ----------

derive_domain_from_site() { # first DNS hostname of a SITE string ("" for raw-IP/:80)
  local first="${1%%,*}" host
  case "$first" in
    https://* | http://*) host="${first#*://}" ;;
    *) return 0 ;;
  esac
  host="${host%%/*}"
  case "$host" in
    *[[:alpha:]]*) printf '%s' "$host" ;;
  esac
}

list_add() { # list_add <csv> <entry> — append once, order-preserving
  local list="$1" entry="$2"
  [ -n "$entry" ] || { printf '%s' "$list"; return 0; }
  case ",$list," in *",$entry,"*) printf '%s' "$list" ;; *)
    [ -n "$list" ] && printf '%s,%s' "$list" "$entry" || printf '%s' "$entry"
  ;; esac
}

env_get() { # env_get <KEY> — last value in the env file ("" when absent)
  [ -f "$ENV_FILE" ] || return 0
  grep "^${1}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

env_set() { # env_set <KEY> <value> — upsert one line, never duplicates
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

detect_public_ip() {
  local ip=""
  ip="$($CURL -fsS -m 4 -H 'Authorization: Bearer Oracle' \
        http://169.254.169.254/opc/v2/instance/ 2>/dev/null \
        | grep -o '"publicIp"[[:space:]]*:[[:space:]]*"[0-9.]*"' | head -n1 \
        | grep -o '[0-9.]\+"' | tr -d '"' || true)"
  case "$ip" in ''|null) ip="$($CURL -4 -fsS -m 6 https://ifconfig.me 2>/dev/null || true)" ;; esac
  [ -n "$ip" ] || { ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; }
  printf '%s' "$ip"
}

dns_check() { # dns_check <host> <server-ip> — warn-only
  local host="$1" ip="$2" resolved
  resolved="$(getent hosts "$host" 2>/dev/null | awk '{print $1; exit}' || true)"
  if [ -z "$resolved" ]; then
    warn "DNS: $host does not resolve yet — add an A record -> $ip (Namecheap: Advanced DNS)"
    return 1
  elif [ "$resolved" != "$ip" ]; then
    warn "DNS: $host resolves to $resolved but this server is $ip — certificate issuance will fail until it points here"
    return 1
  fi
  ok "DNS: $host -> $ip"
}

gateway_running() { # does the public gateway service exist on this box?
  "$SYSTEMCTL" list-unit-files 2>/dev/null | grep -q '^caddy\.service' || \
    "$SYSTEMCTL" is-active --quiet caddy 2>/dev/null
}

# ---------- gateway config rendering ----------

# Render from the repo template (exact same output as deploy-oracle-vps.sh),
# or patch the existing baked file in place when the template is unavailable.
apply_gateway_config() { # apply_gateway_config <domain> <site-list> <public-ip-or-"">
  local domain="$1" site="$2" ip="$3" site_render ip_esc

  if [ -f "$TEMPLATE" ]; then
    # Caddyfile site-address lists need a SPACE after each comma
    # ("https://d, http://ip") — a bare comma reads as one invalid address.
    site_render="${site//,/, }"
    sed -e "s|{\$SITE_ADDRESS}|${site_render}|g" \
        -e 's|reverse_proxy api:3003|reverse_proxy 127.0.0.1:3003|g' \
        -e 's|reverse_proxy web:3000|reverse_proxy 127.0.0.1:3000|g' \
        "$TEMPLATE" > "$CADDYFILE"
    log "gateway config rendered from repo template ($TEMPLATE)"
  else
    log "repo template not found — patching the existing config in place"
    [ -f "$CADDYFILE" ] || die "no gateway config at $CADDYFILE and no template at $TEMPLATE"
    # fix site lists missing the space after a comma (https://d,http://ip)
    sed -Ei 's/,(https?:\/\/|:80)/, \1/g' "$CADDYFILE"
    case "$(head -c 4000 "$CADDYFILE")" in
      *"https://$domain"*) : ;;
      *) warn "baked config has no https://$domain site yet — the next server-update re-render (or a re-run of this script after restoring the repo template) finishes that part" ;;
    esac
  fi

  # ── www alias: own auto-TLS certificate + 308 redirect to the apex ──────
  # Idempotent: only appended when the block is not already present.
  if ! grep -Eq "^www\.$(printf '%s' "$domain" | sed 's/\./\\./g')[[:space:]]*\{" "$CADDYFILE"; then
    cat >> "$CADDYFILE" <<EOF

# www -> apex canonical redirect (appended by blasti-ssl.sh).
# Caddy obtains and renews a separate certificate for www.${domain}.
www.${domain} {
        redir https://${domain}{uri} 308
}
EOF
    ok "www site block ensured in the config (www.$domain -> https://$domain, 308 + own auto-TLS cert)"
  else
    ok "www site block already present in the baked config — nothing to add"
  fi

  # ── legacy raw-IP rescue (strict-HTTPS) ──────────────────────────────
  # A bare IP can never get a TLS certificate: clients still baked with
  # http://IP used to hit the gateway's automatic http->https redirect and
  # die on a dead TLS handshake. When the IP is NOT a serving door anywhere
  # in this config, give it a REDIRECT-ONLY block to the canonical apex.
  # (Broad string match — a second block for the same host would make the
  # whole config invalid.)
  case "$ip" in
    '' | 10.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 192.168.*) : ;; # unknown/private — skip
    *)
      ip_esc="$(printf '%s' "$ip" | sed 's/\./\\./g')"
      if grep -q "http://$ip_esc" "$CADDYFILE"; then
        : # the IP is already a serving door (dual-door bridge) — leave it alone
      else
        cat >> "$CADDYFILE" <<EOF

# legacy raw-IP clients -> canonical apex (appended by blasti-ssl.sh).
# Cleartext door is redirect-only: no app or API is served over plain HTTP.
http://${ip} {
        redir https://${domain}{uri} 308
}
EOF
        ok "raw-IP rescue block added: http://$ip -> https://$domain (308, redirect-only)"
      fi
    ;;
  esac
}

# ---------- verification ----------

http_code() { # http_code <url> [extra curl args...]
  local url="$1"; shift
  "$CURL" -sk -m 10 -o /dev/null -w '%{http_code}' "$@" "$url" 2>/dev/null || printf '000'
}

verify_https() { # verify_https <domain> — retries while certificates are issued
  local domain="$1" apex="https://$domain" www="https://www.$domain"
  local i code loc
  log "verifying HTTPS (first certificate issuance can take up to ~60s)..."
  for i in $(seq 1 12); do
    code="$(http_code "$apex/api/health")"
    case "$code" in
      200) ok "https://$domain/api/health -> 200 (HTTPS + certificate OK)" ;;
      *)   [ "$i" = 12 ] && warn "https://$domain/api/health -> $code (expected 200)" ;;
    esac

    code="$(http_code "$www/")"
    loc="$("$CURL" -sk -m 10 -o /dev/null -w '%{redirect_url}' "$www/" 2>/dev/null || true)"
    if [ "$code" = "308" ] && [ "$loc" = "$apex/" ]; then
      ok "https://www.$domain -> 308 redirect to $apex (www certificate issued)"
      return 0
    fi

    if [ "$i" -lt 12 ]; then
      printf '\r[ssl] waiting for the www certificate... (%s/12)\r' "$i"
      sleep 5
    fi
  done
  printf '\n'
  warn "www did not return 308 yet (last code: $code, redirect: ${loc:-none})."
  warn "  usual causes: www DNS does not point here yet, or ports 80/443 closed."
  warn "  inspect with:  journalctl -u caddy -n 30 --no-pager ; then re-run this script."
  return 1
}

verify_only() { # --check mode: DNS + live HTTPS probe, zero changes
  local domain="$1" ip code loc
  ip="$(detect_public_ip)"
  log "check mode — server IP: ${ip:-unknown}"
  dns_check "$domain" "$ip" || true
  dns_check "www.$domain" "$ip" || true
  code="$(http_code "https://$domain/api/health")"
  case "$code" in
    200) ok "https://$domain/api/health -> 200" ;;
    *)   warn "https://$domain/api/health -> $code (expected 200)" ;;
  esac
  code="$(http_code "https://www.$domain/")"
  loc="$("$CURL" -sk -m 10 -o /dev/null -w '%{redirect_url}' "https://www.$domain/" 2>/dev/null || true)"
  if [ "$code" = "308" ] && [ "$loc" = "https://$domain/" ]; then
    ok "https://www.$domain -> 308 redirect to https://$domain"
  else
    warn "https://www.$domain -> $code ${loc:+(redirect: $loc)} — re-run without --check to fix"
  fi
  ok "check finished"
}

# ---------- main ----------

main() {
  local domain="" mode="apply"
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) mode="check"; shift ;;
      --help|-h) sed -n '2,40p' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
      "") shift ;;
      -*) die "unknown argument: $1 (try --help)" ;;
      *) domain="$1"; shift ;;
    esac
  done

  [ "$(id -u)" -eq 0 ] || [ "${BLASTI_SSL_SKIP_ROOT_CHECK:-0}" = "1" ] || die "run as root:  sudo bash $0"

  local site ip
  site="$(env_get SITE_ADDRESS)"
  [ -n "$domain" ] || domain="$(derive_domain_from_site "$site")"
  [ -n "$domain" ] || domain="$DEFAULT_DOMAIN"
  case "$domain" in www.*) domain="${domain#www.}" ;; esac   # accept www.x, work on x
  ip="$(detect_public_ip)"

  echo "============================================================"
  echo " BLASTI HTTPS enabler — $(date '+%F %T %Z')"
  echo " domain : $domain  (+ www.$domain)"
  echo " server : ${ip:-unknown}"
  echo "============================================================"

  if [ "$mode" = "check" ]; then
    verify_only "$domain"
    return 0
  fi

  # -- 1. preflight --------------------------------------------------------
  [ -f "$ENV_FILE" ] || die "$ENV_FILE missing — run the deploy installer first (server-install)"
  [ -f "$CADDYFILE" ] || [ -f "$TEMPLATE" ] || die "no gateway config at $CADDYFILE and no template at $TEMPLATE — run server-install first"
  [ -f "$TEMPLATE" ] && ok "repo template found: $TEMPLATE" || warn "template missing — the existing config will be patched in place"

  dns_check "$domain" "$ip" || true
  dns_check "www.$domain" "$ip" || true

  # -- 2. app-side .env update (SITE_ADDRESS + both origin lists) ----------
  # STRICT-HTTPS: in domain mode the config serves https://<domain> ONLY —
  # cleartext doors (:80, http://IP) are REMOVED from the site list and from
  # the origin lists; the raw-IP rescue redirect below sends any leftover
  # http://IP client straight to the canonical apex.
  log "updating $ENV_FILE (SITE_ADDRESS + CORS origins)..."
  local cur_site entry out="https://$domain"
  cur_site="$(env_get SITE_ADDRESS)"
  [ -n "$cur_site" ] || cur_site="https://$domain"
  local old_ifs="$IFS"; IFS=','
  for entry in $cur_site; do
    entry="$(printf '%s' "$entry" | tr -d '[:space:]')"
    [ -n "$entry" ] || continue
    [ "$entry" = "https://$domain" ] && continue          # apex handled above
    case "$entry" in
      :80 | http://*) continue ;;                        # cleartext door — dropped
      *) out="$(list_add "$out" "$entry")" ;;
    esac
  done
  IFS="$old_ifs"
  env_set SITE_ADDRESS "$out"

  local key cors kept e2
  for key in CORS_ORIGIN ALLOWED_ORIGINS; do
    cors="$(env_get "$key")"
    [ -n "$cors" ] || cors="https://$domain"
    kept=""
    old_ifs="$IFS"; IFS=','
    for e2 in $cors; do
      e2="$(printf '%s' "$e2" | tr -d '[:space:]')"
      [ -n "$e2" ] || continue
      case "$e2" in
        "http://$domain" | "http://www.$domain" | "http://$ip") continue ;;  # strict-HTTPS
        *) kept="$(list_add "$kept" "$e2")" ;;
      esac
    done
    IFS="$old_ifs"
    cors="$(list_add "$(list_add "$kept" "https://$domain")" "https://www.$domain")"
    env_set "$key" "$cors"
  done
  ok ".env updated (strict-HTTPS) — SITE_ADDRESS=$out"

  # -- 3. gateway config: render/patch + www block + validate + reload -----
  cp "$CADDYFILE" "$CADDYFILE.pre-ssl.bak" 2>/dev/null || true
  apply_gateway_config "$domain" "$(env_get SITE_ADDRESS)" "$ip"

  if ! "$CADDY_BIN" validate --config "$CADDYFILE" >/dev/null 2>&1; then
    warn "generated config is invalid — restoring the backup"
    [ -f "$CADDYFILE.pre-ssl.bak" ] && cp "$CADDYFILE.pre-ssl.bak" "$CADDYFILE"
    "$CADDY_BIN" validate --config "$CADDYFILE" || true
    die "gateway config invalid — paste $(basename "$CADDYFILE") output of: $CADDY_BIN validate --config $CADDYFILE"
  fi
  ok "gateway config validates clean"

  # -- 4. restart what picked the changes up (api: CORS env, caddy: config) -
  if gateway_running; then
    "$SYSTEMCTL" reload caddy 2>/dev/null || "$SYSTEMCTL" restart caddy
    ok "gateway reloaded (https://$domain + https://www.$domain live)"
    if "$SYSTEMCTL" list-unit-files 2>/dev/null | grep -q '^blasti-api\.service'; then
      "$SYSTEMCTL" restart blasti-api.service
      ok "blasti-api restarted (picks up the updated CORS origins)"
    fi
  else
    warn "caddy service not found — config written but not reloaded; start the gateway and re-run"
  fi

  # -- 5. verify ------------------------------------------------------------
  verify_https "$domain" || true

  cat <<EOF

  ============================================================
   BLASTI HTTPS is ON.

   Web app      :  https://$domain
   API health   :  https://$domain/api/health
   WWW alias    :  https://www.$domain  ->  https://$domain
                   (308 redirect, own auto-TLS certificate)
   Certificates :  issued + renewed automatically by the gateway
                   (HTTP-01 challenge on port 80 — keep it open)
  ============================================================
   Re-check anytime:   sudo bash $0 --check
EOF
}

main "$@"
