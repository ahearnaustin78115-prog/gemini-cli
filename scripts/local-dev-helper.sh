#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  local-dev-helper.sh install <package.apk|package.deb|package.rpm>
  local-dev-helper.sh status
  local-dev-helper.sh db-diff <migration-name>
  local-dev-helper.sh db-dump
  local-dev-helper.sh stop

The Supabase commands run in the current directory. `db-dump` writes
data-only SQL to supabase/seed.sql, and `stop` runs `supabase stop --no-backup`.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

install_package() {
  [[ $# -eq 1 ]] || fail "install requires exactly one package file"
  local package_file=$1
  [[ -f "$package_file" ]] || fail "package file not found: $package_file"

  local package_path
  case "$package_file" in
    /*) package_path=$package_file ;;
    *) package_path=$PWD/$package_file ;;
  esac

  local extension=${package_file##*.}
  extension=$(printf '%s' "$extension" | tr '[:upper:]' '[:lower:]')
  require_command sudo

  case "$extension" in
    apk)
      require_command apk
      sudo apk add --allow-untrusted "$package_path"
      ;;
    deb)
      require_command dpkg
      sudo dpkg -i "$package_path"
      ;;
    rpm)
      require_command rpm
      sudo rpm -i "$package_path"
      ;;
    *)
      fail "unsupported package type: .$extension (expected .apk, .deb, or .rpm)"
      ;;
  esac
}

format_status() {
  local status_output
  if status_output=$(supabase status); then
    :
  else
    return $?
  fi

  printf '%s\n' "$status_output" | awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }

    {
      line = $0
      esc = sprintf("%c", 27)
      gsub(esc "\\[[0-9;]*[[:alpha:]]", "", line)
      if (index(line, "│") == 0) {
        next
      }

      count = split(line, cells, "│")
      label = trim(cells[2])
      value = trim(cells[3])

      if (label == "Database") {
        section = "database"
        next
      }
      if (label == "Authentication Keys") {
        section = "authentication"
        next
      }

      if (label == "Studio" || label == "Studio URL") {
        studio = value
        if (studio == "http://127.0.0.1:54323") {
          studio = "http://localhost:54323"
        }
      } else if (label == "Mailpit" || label == "Mailpit URL") {
        mailpit = value
      } else if (label == "MCP") {
        mcp = value
      } else if (label == "Project URL" || label == "API URL") {
        project = value
      } else if (label == "REST") {
        rest = value
      } else if (label == "GraphQL") {
        graphql = value
      } else if (label == "Edge Functions") {
        functions = value
      } else if (label == "URL" && section == "database") {
        database = value
      } else if (label == "Publishable" && section == "authentication") {
        publishable = value
      } else if (label == "Secret" && section == "authentication") {
        secret = value
      }
    }

    END {
      if (studio == "" && mailpit == "" && mcp == "" && project == "" &&
          rest == "" && graphql == "" && functions == "" && database == "" &&
          publishable == "" && secret == "") {
        print "Error: could not parse Supabase status output" > "/dev/stderr"
        exit 1
      }
      print "Supabase local development"
      printf "Studio: %s\n", studio == "" ? "http://localhost:54323" : studio
      if (mailpit != "") print "Mailpit: " mailpit
      if (mcp != "") print "MCP: " mcp
      if (project != "") print "Project URL: " project
      if (rest != "") print "REST: " rest
      if (graphql != "") print "GraphQL: " graphql
      if (functions != "") print "Edge Functions: " functions
      if (database != "") print "Database URL: " database
      if (publishable != "") print "Publishable key: " publishable
      if (secret != "") print "Secret key: " secret
    }
  '
}

dump_data() {
  [[ -d supabase ]] || fail "supabase/ directory not found in the current directory"
  local temp_file
  temp_file=$(mktemp "supabase/seed.sql.XXXXXX")
  if supabase db dump --data-only >"$temp_file"; then
    if mv "$temp_file" supabase/seed.sql; then
      return 0
    else
      local status=$?
      rm -f "$temp_file"
      return "$status"
    fi
  else
    local status=$?
    rm -f "$temp_file"
    return "$status"
  fi
}

[[ $# -gt 0 ]] || {
  usage >&2
  exit 2
}

action=$1
shift

case "$action" in
  install)
    install_package "$@"
    ;;
  status)
    [[ $# -eq 0 ]] || fail "status does not accept arguments"
    require_command supabase
    format_status
    ;;
  db-diff)
    [[ $# -eq 1 ]] || fail "db-diff requires exactly one migration name"
    require_command supabase
    supabase db diff -f "$1"
    ;;
  db-dump)
    [[ $# -eq 0 ]] || fail "db-dump does not accept arguments"
    require_command supabase
    dump_data
    ;;
  stop)
    [[ $# -eq 0 ]] || fail "stop does not accept arguments"
    require_command supabase
    supabase stop --no-backup
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage >&2
    fail "unknown action: $action"
    ;;
esac
