#pragma once
#include "SettingsStore.hpp"

ConnectionSettings &connectionSettings();
void persistSettings(const ConnectionSettings &settings);
void ensureReceiverRunning();
void showSettingsWindow();
void closeSettingsWindow();
bool settingsWindowHealthy();
void registerParticipantSource();
void addParticipantToCurrentScene(const std::string &userId, const std::string &displayName);
