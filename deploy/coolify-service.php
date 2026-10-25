<?php
// Create or update the Agent Bench compose service in Coolify. Mirrors what Coolify's own
// API does for POST /services with docker_compose_raw (ServicesController), so the result is a
// normal Coolify-managed service. Run inside the coolify container:
//   docker exec coolify php artisan tinker --execute='require "/tmp/agent-bench/coolify-service.php";'
// Inputs (copied into /tmp/agent-bench/ by deploy/deploy.sh, removed afterwards):
//   compose.yaml   the docker compose file
//   config.json    {"name": …, "domains": {"director": "https://host:port", "hub": "https://host2:port"}, "env": {KEY: value}}
//                  (older form: "domain" + "container" for a single public container)
use App\Actions\Service\StartService;
use App\Models\Project;
use App\Models\Server;
use App\Models\Service;

$dir = '/tmp/agent-bench';
$cfg = json_decode(file_get_contents("$dir/config.json"), true, 512, JSON_THROW_ON_ERROR);
$compose = file_get_contents("$dir/compose.yaml");
Symfony\Component\Yaml\Yaml::parse($compose); // fail early on bad YAML

$teamId = 0;
$name = $cfg['name'];
$project = Project::whereTeamId($teamId)->where('name', $name)->first()
    ?? Project::create(['name' => $name, 'description' => 'MTG Deck Tools Agent Benchmark', 'team_id' => $teamId]);
$environment = $project->environments()->where('name', 'production')->first()
    ?? $project->environments()->create(['name' => 'production']);
$server = Server::whereTeamId($teamId)->where('name', 'localhost')->firstOrFail();
$destination = $server->destinations()->first();

$service = Service::where('environment_id', $environment->id)->where('name', $name)->first();
$isNew = ! $service;
if ($isNew) {
    $service = new Service;
    $service->name = $name;
    $service->description = 'MTG Deck Tools Agent Benchmark: phase-server + director + hub';
    $service->environment_id = $environment->id;
    $service->server_id = $server->id;
    $service->destination_id = $destination->id;
    $service->destination_type = $destination->getMorphClass();
    $service->connect_to_docker_network = false;
}
// Variables the owner manages in Coolify's UI (the GitHub OAuth App credentials). Coolify's serviceParser keeps
// user-set variables (simple ${VAR} references are firstOrCreate'd, never updated or pruned), but snapshot them
// anyway and put back any row that vanished or was blanked. Values are never printed.
$managed = $isNew ? collect() : $service->environment_variables()->where('key', 'like', 'GITHUB\_%')->get();
$service->docker_compose_raw = $compose;
$service->save();
$service->parse(isNew: $isNew);

foreach ($cfg['env'] as $key => $value) {
    $service->environment_variables()->updateOrCreate(['key' => $key], ['value' => (string) $value, 'is_literal' => true]);
}
$domains = $cfg['domains'] ?? [$cfg['container'] => $cfg['domain']];
foreach ($domains as $container => $fqdn) {
    $app = $service->applications()->where('name', $container)->firstOrFail();
    $app->fqdn = $fqdn;
    $app->save();
}
$service->parse();
$service->refresh();

foreach ($managed as $row) {
    if (array_key_exists($row->key, $cfg['env'])) {
        continue; // deploy.sh passed a new value on purpose (local file)
    }
    $current = $service->environment_variables()->where('key', $row->key)->first();
    if (! $current) {
        $row->replicate()->save();
        echo "restored env {$row->key} (had vanished)\n";
    } elseif ((string) $current->value === '' && (string) $row->value !== '') {
        $current->value = $row->value;
        $current->save();
        echo "restored env {$row->key} (had been blanked)\n";
    }
}

// Coolify stores a compose default (${VAR:-default}) as the variable's value when it first parses the service and keeps
// it: a later change to the default in compose.yaml never reaches a running service (HUB_PLAY_DAILY stayed 4 after the
// default became 6, 2026-10-22). Report every stored value that differs from the shipped default, names only for
// secrets; deploy.sh's own values (config.json) and the variables managed in the UI are expected to differ.
preg_match_all('/\$\{([A-Z0-9_]+):-([^}]*)\}/', $compose, $m, PREG_SET_ORDER);
foreach ($m as [, $key, $default]) {
    if (array_key_exists($key, $cfg['env']) || str_starts_with($key, 'GITHUB_')) {
        continue;
    }
    $row = $service->environment_variables()->where('key', $key)->first();
    if ($row && (string) $row->value !== $default) {
        $secret = preg_match('/TOKEN|SECRET|PASSWORD|SALT|KEY/', $key);
        echo "warning: env {$key} is " . ($secret ? 'set' : "\"{$row->value}\"") . " in Coolify, but compose.yaml's default is " . ($secret ? 'different' : "\"{$default}\"") . " (set it in Coolify if the default should apply; docs/OPERATIONS.md \"Coolify variables\")\n";
    }
}

StartService::run($service);
echo ($isNew ? 'created' : 'updated') . " service {$service->uuid} in project {$project->uuid}\n";
