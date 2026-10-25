<?php
// Create or update the Agent Bench application in Coolify: a Docker Compose application built from the GitHub
// repository (deploy/compose.yaml, base directory /deploy), deployed from one branch per instance. Mirrors what
// Coolify's API does for POST /applications/private-github-app (ApplicationsController), so the result is a normal
// Coolify-managed application: the owner can deploy, read logs and edit variables in Coolify's UI, and pushes to the
// branch deploy it through the GitHub App's webhook. Run by deploy/coolify-setup.sh inside the coolify container:
//   docker exec coolify php artisan tinker --execute='require "/tmp/agent-bench-setup/coolify-app.php";'
// Input /tmp/agent-bench-setup/config.json (copied in by coolify-setup.sh, removed afterwards; mode 600, holds secrets):
//   {"name", "description", "github_app", "repository", "branch", "domains": {service: "https://host:port"},
//    "env": {KEY: value}, "auto_deploy": bool, "deploy": bool, "commit": sha or null (the branch's head), "delete": bool}
// Prints names and ids only, never a variable's value.
use App\Jobs\DeleteResourceJob;
use App\Models\Application;
use App\Models\GithubApp;
use App\Models\Project;
use App\Models\ScheduledTask;
use App\Models\Server;
use App\Support\DomainPortOverrides;
use Illuminate\Support\Facades\Http;

$dir = '/tmp/agent-bench-setup';
$cfg = json_decode(file_get_contents("$dir/config.json"), true, 512, JSON_THROW_ON_ERROR);
$teamId = 0;
$name = $cfg['name'];

$project = Project::whereTeamId($teamId)->where('name', $name)->first();
$environment = $project?->environments()->where('name', 'production')->first();
$app = $environment ? Application::where('environment_id', $environment->id)->where('name', $name)->first() : null;

// A throwaway instance: remove the application, its containers, volumes and network, then the empty project.
if ($cfg['delete'] ?? false) {
    if (! str_contains($name, 'test')) {
        throw new RuntimeException("refusing to delete $name: only a test instance is deleted by this script");
    }
    if ($app) {
        DeleteResourceJob::dispatchSync($app, deleteVolumes: true, deleteConnectedNetworks: true, deleteConfigurations: true, dockerCleanup: true);
        echo "deleted application {$app->uuid} (containers, volumes, network, configuration)\n";
    }
    if ($project && $project->applications()->count() === 0 && $project->services()->count() === 0) {
        $project->environments()->each(fn ($e) => $e->delete());
        $project->delete();
        echo "deleted project $name\n";
    }

    return;
}

// A new project comes with a `production` environment.
$project ??= Project::create(['name' => $name, 'description' => 'MTG Deck Tools Agent Bench', 'team_id' => $teamId]);
$environment ??= $project->environments()->where('name', 'production')->first() ?? $project->environments()->create(['name' => 'production']);
$server = Server::whereTeamId($teamId)->where('name', 'localhost')->firstOrFail();
$destination = $server->destinations()->first();
$source = GithubApp::where('name', $cfg['github_app'])->firstOrFail();

// The GitHub App must see the repository (Coolify's API checks the same way, and stores the repository id).
$repo = Http::GitHub($source->api_url, generateGithubInstallationToken($source))->timeout(20)->get("/repos/{$cfg['repository']}");
if (! $repo->successful()) {
    throw new RuntimeException("the GitHub App {$source->name} can't see {$cfg['repository']} (HTTP {$repo->status()}): grant it the repository in GitHub, Settings > Applications > {$source->name} > Configure");
}

$isNew = ! $app;
if ($isNew) {
    $app = new Application;
    $app->environment_id = $environment->id;
    $app->destination_id = $destination->id;
    $app->destination_type = $destination->getMorphClass();
}
$app->name = $name;
$app->description = $cfg['description'];
$app->source_type = $source->getMorphClass();
$app->source_id = $source->id;
$app->repository_project_id = data_get($repo->json(), 'id');
$app->git_repository = $cfg['repository'];
$app->git_branch = $cfg['branch'];
$app->git_commit_sha = 'HEAD';
$app->build_pack = 'dockercompose';
$app->base_directory = '/deploy';
$app->docker_compose_location = '/compose.yaml';
$app->ports_exposes = '80';
// Public services and their container ports (https://host:8787 -> the host, routed to 8787), stored as the API does.
$domains = collect($cfg['domains']);
$app->docker_compose_domains = json_encode($domains->map(fn ($url) => ['domain' => DomainPortOverrides::withoutPort($url)])->all());
$app->domain_port_overrides = DomainPortOverrides::normalize($domains->implode(','), null)['overrides'];
$app->save();
$app->refresh();

$settings = $app->settings;
$settings->is_auto_deploy_enabled = (bool) $cfg['auto_deploy'];  // a push to the branch deploys it (GitHub App webhook)
$settings->include_source_commit_in_build = true;                // SOURCE_COMMIT tags the image (compose.yaml)
$settings->inject_build_args_to_dockerfile = false;              // the Dockerfile stays as committed; nothing leaks into it
$settings->is_preview_deployments_enabled = false;
$settings->is_raw_compose_deployment_enabled = false;
$settings->connect_to_docker_network = false;                    // only the application's own network (H-8)
$settings->is_force_https_enabled = true;
$settings->save();

// The compose file from the branch: Coolify parses it and creates a variable for every ${VAR} it references.
$app->loadComposeFile();
$app->refresh();

foreach ($cfg['env'] as $key => $value) {
    $app->environment_variables()->updateOrCreate(
        ['key' => $key, 'is_preview' => false],
        ['value' => (string) $value, 'is_literal' => true, 'is_runtime' => true, 'is_buildtime' => false],
    );
}
// The commit decides the image and the engine: no variable may pin either.
foreach (['PHASE_IMAGE', 'DIRECTOR_TAG', 'SOURCE_COMMIT'] as $key) {
    if ($app->environment_variables()->where('key', $key)->delete()) {
        echo "removed variable $key (the commit decides it)\n";
    }
}
// Nothing the image build needs comes from a variable, so none reaches the build (no secret in a build context).
$app->environment_variables()->update(['is_buildtime' => false]);

// The Hub database's nightly logical dump (docs/OPERATIONS.md "Backups and Restore"), as on the old dev service.
ScheduledTask::updateOrCreate(
    ['application_id' => $app->id, 'name' => 'hub-db nightly pg_dump'],
    ['command' => "sh -c 'pg_dump -U hub -Fc -f /dumps/hub-\$(date +%a).dump hub'", 'frequency' => '20 2 * * *', 'container' => 'hub-db',
        'enabled' => true, 'timeout' => 900, 'team_id' => $teamId],
);

// Coolify creates an empty variable for each ${VAR:-default} in compose.yaml; empty, the compose default applies, so a
// new default ships with its commit. A value set in Coolify overrides it for good (docs/OPERATIONS.md "Coolify
// variables"): report each one that differs from the shipped default; names only for secrets.
preg_match_all('/\$\{([A-Z0-9_]+):-([^}$]*)\}/', $app->docker_compose_raw, $m, PREG_SET_ORDER);
foreach ($m as [, $key, $default]) {
    if (array_key_exists($key, $cfg['env']) || str_starts_with($key, 'GITHUB_')) {
        continue;
    }
    $row = $app->environment_variables()->where('key', $key)->first();
    if ($row && (string) $row->value !== '' && (string) $row->value !== $default) {
        $secret = preg_match('/TOKEN|SECRET|PASSWORD|SALT|KEY/', $key);
        echo "note: env {$key} is ".($secret ? 'set' : "\"{$row->value}\"")." in Coolify, overriding compose.yaml's default ".($secret ? '' : "\"{$default}\"")."\n";
    }
}

echo ($isNew ? 'created' : 'updated')." application {$app->uuid} in project {$project->uuid}: {$cfg['repository']}@{$cfg['branch']}, auto-deploy ".($cfg['auto_deploy'] ? 'on' : 'off')."\n";
if ($cfg['deploy'] ?? false) {
    $result = queue_application_deployment(application: $app, deployment_uuid: new_public_id(), commit: $cfg['commit'] ?? null, no_questions_asked: true, is_api: true);
    echo "deployment: {$result['status']}".(isset($result['deployment_uuid']) ? " {$result['deployment_uuid']}" : '')."\n";
}
