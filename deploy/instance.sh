# Sourced by deploy/deploy.sh and deploy/coolify-setup.sh: what each Agent Bench instance is on Coolify.
#   instance_config <dev|prod|test>   sets: name (Coolify project and application), branch (the git branch Coolify deploys),
#                                     domain (Director), hub_domain (Hub), secrets (the workstation's copy of its secrets)
# dev: an unlisted dev stack. prod: the public stack (docs/OPERATIONS.md "Deploying"). test: a throwaway copy for trying a branch
# (TEST_BRANCH, default the current branch); delete it afterwards with deploy/coolify-setup.sh --delete.
# Dev and test need DOMAIN and HUB_DOMAIN. Prod uses the public hosts unless both are set.
instance_config() {
  case "$1" in
    dev)
      name="agent-bench"
      branch="deploy/dev"
      domain="${DOMAIN:?INSTANCE=dev needs DOMAIN}"
      hub_domain="${HUB_DOMAIN:?INSTANCE=dev needs HUB_DOMAIN}"
      secrets="$HOME/.config/mtgdt" ;;
    prod)
      name="agent-bench-prod"
      branch="deploy/prod"
      domain="${DOMAIN:-bench.mtgdecktools.com}"
      hub_domain="${HUB_DOMAIN:-bench-data.mtgdecktools.com}"
      case "$domain $hub_domain" in *.dev.*) echo "INSTANCE=prod with a dev host ($domain, $hub_domain): refusing"; return 2 ;; esac
      secrets="$HOME/.config/mtgdt-prod" ;;
    test)
      name="agent-bench-git-test"
      branch="${TEST_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
      case "$branch" in main|deploy/*) echo "INSTANCE=test deploys a work branch, not $branch"; return 2 ;; esac
      domain="${DOMAIN:?INSTANCE=test needs DOMAIN}"
      hub_domain="${HUB_DOMAIN:?INSTANCE=test needs HUB_DOMAIN}"
      secrets="$HOME/.config/mtgdt-test" ;;
    *) echo "INSTANCE must be dev, prod or test"; return 2 ;;
  esac
}
