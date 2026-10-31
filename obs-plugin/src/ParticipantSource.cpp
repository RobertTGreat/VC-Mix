#include "ReceiverBridge.hpp"
#include "PluginContext.hpp"
#include <obs-frontend-api.h>
#include <stdexcept>

namespace {
constexpr const char *SOURCE_ID = "discord_voice_participant";
// The stable source identifier preserves existing OBS scenes across the product rename.

struct ParticipantSource {
  obs_source_t *source;
};

void updateSource(void *context, obs_data_t *settings)
{
  auto *capture = static_cast<ParticipantSource *>(context);
  receiver().addSource(capture->source, obs_data_get_string(settings, "user_id"));
}

void *createSource(obs_data_t *settings, obs_source_t *source)
{
  auto *capture = new ParticipantSource{source};
  updateSource(capture, settings);
  return capture;
}

void destroySource(void *context)
{
  auto *capture = static_cast<ParticipantSource *>(context);
  receiver().removeSource(capture->source);
  delete capture;
}

bool openSettings(obs_properties_t *, obs_property_t *, void *)
{
  showSettingsWindow();
  return false;
}

void populateParticipants(obs_property_t *list, obs_source_t *source)
{
  obs_property_list_clear(list);
  obs_property_list_add_string(list, "Select a participant after connecting…", "");
  auto snapshot = receiver().snapshot();
  for (const auto &participant : snapshot.participants) {
    const auto label = participant.name + " (" + participant.userId + ")";
    obs_property_list_add_string(list, label.c_str(), participant.userId.c_str());
  }
  if (!source) return;
  auto *settings = obs_source_get_settings(source);
  const std::string selectedId = obs_data_get_string(settings, "user_id");
  const std::string selectedName = obs_data_get_string(settings, "participant_name");
  obs_data_release(settings);
  if (selectedId.empty()) return;
  for (const auto &participant : snapshot.participants) if (participant.userId == selectedId) return;
  const auto label = (selectedName.empty() ? selectedId : selectedName) + " (offline)";
  obs_property_list_add_string(list, label.c_str(), selectedId.c_str());
}

bool refreshParticipants(obs_properties_t *properties, obs_property_t *, void *context)
{
  auto *capture = static_cast<ParticipantSource *>(context);
  populateParticipants(obs_properties_get(properties, "user_id"), capture ? capture->source : nullptr);
  return true;
}

obs_properties_t *sourceProperties(void *context)
{
  auto *properties = obs_properties_create();
  auto *list = obs_properties_add_list(properties, "user_id", "Participant", OBS_COMBO_TYPE_LIST, OBS_COMBO_FORMAT_STRING);
  auto *capture = static_cast<ParticipantSource *>(context);
  populateParticipants(list, capture ? capture->source : nullptr);
  obs_properties_add_button(properties, "refresh", "Refresh participants", refreshParticipants);
  obs_properties_add_button(properties, "settings", "Open VC Mix settings", openSettings);
  return properties;
}
}

void registerParticipantSource()
{
  obs_source_info information{};
  information.id = SOURCE_ID;
  information.type = OBS_SOURCE_TYPE_INPUT;
  information.output_flags = OBS_SOURCE_AUDIO;
  information.get_name = [](void *) { return "VC Mix Participant"; };
  information.create = createSource;
  information.destroy = destroySource;
  information.update = updateSource;
  information.get_properties = sourceProperties;
  information.icon_type = OBS_ICON_TYPE_AUDIO_INPUT;
  obs_register_source(&information);
}

void addParticipantToCurrentScene(const std::string &userId, const std::string &displayName)
{
  auto *sceneSource = obs_frontend_get_current_scene();
  if (!sceneSource) throw std::runtime_error("Create or select an OBS scene first.");
  auto *scene = obs_scene_from_source(sceneSource);
  if (!scene) { obs_source_release(sceneSource); throw std::runtime_error("The selected scene is unavailable."); }
  std::string name = "VC Mix — " + displayName;
  unsigned suffix = 2;
  while (auto *existing = obs_get_source_by_name(name.c_str())) {
    obs_source_release(existing);
    name = "VC Mix — " + displayName + " (" + std::to_string(suffix++) + ")";
  }
  auto *settings = obs_data_create();
  obs_data_set_string(settings, "user_id", userId.c_str());
  obs_data_set_string(settings, "participant_name", displayName.c_str());
  auto *source = obs_source_create(SOURCE_ID, name.c_str(), settings, nullptr);
  obs_data_release(settings);
  if (!source) { obs_source_release(sceneSource); throw std::runtime_error("OBS could not create the participant source."); }
  obs_scene_add(scene, source);
  obs_source_release(source);
  obs_source_release(sceneSource);
}
