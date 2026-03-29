#!/bin/bash
#
# buying-bot — CLI launcher for the Flipkart buying bot
#
# Usage:
#   buying-bot start                    Start the Next.js web app (required for the dashboard)
#   buying-bot run <config.json>        Run the automation with a config file
#   buying-bot simple                   Run the standalone bot.js (no web app needed)
#   buying-bot --help                   Show this help
#
# Global install (macOS):
#   chmod +x buying-bot.sh
#   mv buying-bot.sh /usr/local/bin/buying-bot
#   # Or: mv buying-bot.sh ~/.local/bin/buying-bot && echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
#
# Requirements:
#   - Node.js 18+ (run: node --version)
#   - npm packages installed (run: npm install)
#   - Chrome installed at /Applications/Google Chrome.app
#

set -e

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ "$BOT_DIR" = "/usr/local/bin" ] && BOT_DIR="$(dirname "$(readlink -f "$0")")"
[ "$BOT_DIR" = "$HOME/.local/bin" ] && BOT_DIR="$(dirname "$(readlink -f "$0")")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_help() {
  echo -e "${CYAN}buying-bot${NC} — Flipkart automated buying bot"
  echo ""
  echo "Usage: ${CYAN}buying-bot <command>${NC}"
  echo ""
  echo "Commands:"
  echo "  ${GREEN}start${NC}                   Start the Next.js web app"
  echo "  ${GREEN}run <config.json>${NC}         Run the automation runner (requires web app running)"
  echo "  ${GREEN}simple${NC}                    Run the standalone bot.js (no web app needed)"
  echo "  ${GREEN}install-chrome${NC}            Install Chrome dependencies (macOS)"
  echo "  ${GREEN}check${NC}                     Check environment and dependencies"
  echo "  ${GREEN}--help${NC}                    Show this help message"
  echo ""
  echo "Examples:"
  echo "  ${YELLOW}buying-bot start${NC}           # Start the dashboard"
  echo "  ${YELLOW}buying-bot simple${NC}          # Run standalone bot"
  echo "  ${YELLOW}buying-bot check${NC}           # Verify your setup"
  echo ""
}

check_deps() {
  echo -e "${CYAN}Checking dependencies...${NC}"

  # Node.js
  if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js not found. Install from https://nodejs.org${NC}"
    exit 1
  fi
  echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

  # npm
  if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm not found${NC}"
    exit 1
  fi
  echo -e "  ${GREEN}✓${NC} npm $(npm -v)"

  # Check node_modules
  if [ ! -d "$BOT_DIR/node_modules" ]; then
    echo -e "${YELLOW}! node_modules not found. Running npm install...${NC}"
    cd "$BOT_DIR" && npm install
  fi

  # Chrome
  if [ -d "/Applications/Google Chrome.app" ]; then
    echo -e "  ${GREEN}✓${NC} Google Chrome (macOS)"
  elif [ -f "/usr/bin/google-chrome" ]; then
    echo -e "  ${GREEN}✓${NC} Google Chrome (Linux)"
  elif command -v google-chrome &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Google Chrome (in PATH)"
  else
    echo -e "${RED}✗ Google Chrome not found at /Applications/Google Chrome.app${NC}"
    echo -e "  ${YELLOW}! Download from https://www.google.com/chrome/${NC}"
  fi

  # puppeteer-core browsers
  if [ -d "$BOT_DIR/node_modules/puppeteer-core/.local-chromium" ]; then
    echo -e "  ${GREEN}✓${NC} Puppeteer Chromium"
  fi

  echo -e "${GREEN}All checks passed!${NC}"
}

cmd_start() {
  echo -e "${CYAN}Starting Next.js web app...${NC}"
  cd "$BOT_DIR"
  exec npm run dev
}

cmd_run() {
  CONFIG_FILE="$1"
  if [ -z "$CONFIG_FILE" ]; then
    echo -e "${RED}Error: run command requires a config file argument${NC}"
    echo -e "Usage: ${CYAN}buying-bot run <config.json>${NC}"
    exit 1
  fi

  if [ ! -f "$BOT_DIR/$CONFIG_FILE" ] && [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}Error: config file not found: $CONFIG_FILE${NC}"
    exit 1
  fi

  echo -e "${CYAN}Running automation with config: $CONFIG_FILE${NC}"
  echo -e "${YELLOW}Make sure the web app is running first (buying-bot start)${NC}"
  echo -e "${CYAN}Starting in 3 seconds...${NC}"
  sleep 3

  # Base64-encode the config and pass to the runner
  CONFIG_B64=$(cat "$BOT_DIR/$CONFIG_FILE" 2>/dev/null || cat "$CONFIG_FILE" 2>/dev/null | base64)
  cd "$BOT_DIR"
  exec npx tsx automation/runner.ts "$CONFIG_B64"
}

cmd_simple() {
  echo -e "${CYAN}Running standalone bot (bot.js)...${NC}"
  echo -e "${YELLOW}No web app needed for this mode.${NC}"
  cd "$BOT_DIR"
  exec node bot.js
}

cmd_install_chrome() {
  echo -e "${CYAN}Installing Chrome for Puppeteer...${NC}"
  cd "$BOT_DIR"
  npx puppeteer browsers install chrome
}

# ── Main ────────────────────────────────────────────────────────────────────

case "${1:-}" in
  start)
    cmd_start
    ;;
  run)
    cmd_run "$2"
    ;;
  simple)
    cmd_simple
    ;;
  install-chrome)
    cmd_install_chrome
    ;;
  check)
    check_deps
    ;;
  --help|-h|"")
    print_help
    ;;
  *)
    echo -e "${RED}Unknown command: $1${NC}"
    print_help
    exit 1
    ;;
esac
