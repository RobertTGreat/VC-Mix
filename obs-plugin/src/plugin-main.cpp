#include <obs-module.h>
#include <obs-frontend-api.h>
#include "PluginContext.hpp"
#include "ReceiverBridge.hpp"
#include <QDialog>
#include <QDir>
#include <QFileInfo>
#include <QPixmap>
#include <filesystem>

OBS_DECLARE_MODULE()
MODULE_EXPORT const char *obs_module_description() { return "Capture Discord voice participants as independent OBS audio sources."; }
MODULE_EXPORT const char *obs_module_name() { return "VC Mix"; }
MODULE_EXPORT const char *obs_module_author() { return "VC Mix contributors"; }

namespace {
ReceiverBridge bridge;
ConnectionSettings settings;
std::string settingsPath;
std::wstring helperDirectory;
UINT_PTR smokeTimer = 0;
unsigned smokeAttempts = 0;

void CALLBACK finishSmokeTest(HWND, UINT, UINT_PTR timer, DWORD)
{
  const auto snapshot = bridge.snapshot();
  const bool hasAudio = settingsWindowHealthy() && snapshot.participants.size() == 2
    && snapshot.participants[0].packets > 30 && snapshot.participants[1].packets > 30;
  if (!hasAudio && ++smokeAttempts < 30) return;
  KillTimer(nullptr, timer);
  smokeTimer = 0;
  blog(hasAudio ? LOG_INFO : LOG_ERROR, "[vc-mix] Frontend smoke test %s: native window, two scene sources, helper audio.", hasAudio ? "PASS" : "FAIL");
  if (!hasAudio) blog(LOG_ERROR, "[vc-mix] Test receiver status: %s. %s", snapshot.status.c_str(), snapshot.error.c_str());
  if (hasAudio) {
    auto *mainWindow = static_cast<QWidget *>(obs_frontend_get_main_window());
    auto *dialog = mainWindow->findChild<QDialog *>("VCMixSettings");
    char *previewPath = obs_module_config_path("settings-preview.png");
    if (previewPath) QDir().mkpath(QFileInfo(QString::fromUtf8(previewPath)).absolutePath());
    if (!dialog || !previewPath || !dialog->grab().save(QString::fromUtf8(previewPath)))
      blog(LOG_WARNING, "[vc-mix] Could not save the diagnostic settings preview.");
    bfree(previewPath);
  }
  PostMessageW(static_cast<HWND>(obs_frontend_get_main_window_handle()), WM_CLOSE, 0, 0);
}

bool beginSmokeTest()
{
  // Explicit diagnostic mode is used only by the isolated portable OBS test script.
  if (std::wstring(GetCommandLineW()).find(L"--vc-mix-test") == std::wstring::npos) return false;
  ensureReceiverRunning();
  bridge.command("test");
  addParticipantToCurrentScene("111111111111111111", "Test voice A (440 Hz)");
  addParticipantToCurrentScene("222222222222222222", "Test voice B (880 Hz)");
  showSettingsWindow();
  smokeTimer = SetTimer(nullptr, 0, 500, finishSmokeTest);
  return true;
}

void frontendEvent(obs_frontend_event event, void *)
{
  if (event == OBS_FRONTEND_EVENT_FINISHED_LOADING) {
    try {
      if (beginSmokeTest()) return;
      if (settings.autoConnect) { ensureReceiverRunning(); bridge.connect(settings); }
    } catch (const std::exception &error) { blog(LOG_WARNING, "[vc-mix] Connection setup failed: %s", error.what()); }
  }
  if (event == OBS_FRONTEND_EVENT_EXIT) { closeSettingsWindow(); bridge.stop(); }
}
}

ReceiverBridge &receiver() { return bridge; }
ConnectionSettings &connectionSettings() { return settings; }
void persistSettings(const ConnectionSettings &updated) { saveSettings(settingsPath, updated); settings = updated; }
void ensureReceiverRunning() { if (!bridge.snapshot().running) bridge.start(helperDirectory); }

bool obs_module_load()
{
  char *configuration = obs_module_config_path("settings.json");
  char *helper = obs_module_file("helper");
  if (!configuration || !helper) { bfree(configuration); bfree(helper); return false; }
  settingsPath = configuration;
  helperDirectory = wide(helper);
  bfree(configuration); bfree(helper);
  try {
    settings = loadSettings(settingsPath);
    // Keep credentials from the previous plugin name on this Windows account.
    const auto legacyPath = std::filesystem::path(wide(settingsPath)).parent_path().parent_path() / L"discord-voice" / L"settings.json";
    if (!std::filesystem::exists(std::filesystem::path(wide(settingsPath))) && std::filesystem::exists(legacyPath)) {
      settings = loadSettings(utf8(legacyPath.wstring()));
      saveSettings(settingsPath, settings);
    }
  }
  catch (const std::exception &error) { blog(LOG_WARNING, "[vc-mix] %s", error.what()); }
  registerParticipantSource();
  obs_frontend_add_tools_menu_item("VC Mix…", [](void *) { showSettingsWindow(); }, nullptr);
  obs_frontend_add_event_callback(frontendEvent, nullptr);
  blog(LOG_INFO, "[vc-mix] Native participant sources registered (version 0.1.0).");
  return true;
}

void obs_module_unload()
{
  obs_frontend_remove_event_callback(frontendEvent, nullptr);
  if (smokeTimer) { KillTimer(nullptr, smokeTimer); smokeTimer = 0; }
  closeSettingsWindow();
  bridge.stop();
  settings.token.clear();
}
