#include "PluginContext.hpp"
#include "ReceiverBridge.hpp"
#include <obs-frontend-api.h>
#include <QCheckBox>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QGroupBox>
#include <QHeaderView>
#include <QLabel>
#include <QLineEdit>
#include <QPointer>
#include <QPushButton>
#include <QStackedWidget>
#include <QStyle>
#include <QTimer>
#include <QTreeWidget>
#include <QVBoxLayout>
#include <functional>
#include <stdexcept>

namespace {
constexpr int WINDOW_WIDTH = 700;
constexpr int WINDOW_HEIGHT = 660;
constexpr int REFRESH_INTERVAL_MS = 500;
constexpr int PARTICIPANT_ID_ROLE = Qt::UserRole;

class SettingsDialog final : public QDialog {
public:
  explicit SettingsDialog(QWidget *parent) : QDialog(parent)
  {
    setObjectName("VCMixSettings");
    setWindowTitle("VC Mix");
    setWindowModality(Qt::NonModal);
    setAttribute(Qt::WA_DeleteOnClose);
    setSizeGripEnabled(true);
    setMinimumWidth(600);
    auto *layout = new QVBoxLayout(this);
    layout->addWidget(createConnectionGroup());
    layout->addLayout(createConnectionActions());
    statusLabel = plainLabel({}, "vcMixStatus");
    layout->addWidget(statusLabel);
    feedbackLabel = plainLabel({}, "vcMixFeedback");
    feedbackLabel->hide();
    layout->addWidget(feedbackLabel);
    layout->addWidget(createParticipantsGroup(), 1);
    layout->addLayout(createFooter());
    loadSettings();
    refreshStatus();
    auto *refreshTimer = new QTimer(this);
    connect(refreshTimer, &QTimer::timeout, this, [this] { refreshStatus(); });
    refreshTimer->start(REFRESH_INTERVAL_MS);
    resize(WINDOW_WIDTH, WINDOW_HEIGHT);
  }

  bool healthy() const
  {
    return isVisible() && !isModal() && tokenInput->echoMode() == QLineEdit::Password
      && participantList && saveButton && connectButton && addSourceButton;
  }

private:
  QLineEdit *tokenInput = nullptr;
  QLineEdit *guildInput = nullptr;
  QLineEdit *channelInput = nullptr;
  QLineEdit *excludedInput = nullptr;
  QCheckBox *autoConnect = nullptr;
  QLabel *statusLabel = nullptr;
  QLabel *feedbackLabel = nullptr;
  QTreeWidget *participantList = nullptr;
  QStackedWidget *participantViews = nullptr;
  QPushButton *saveButton = nullptr;
  QPushButton *connectButton = nullptr;
  QPushButton *addSourceButton = nullptr;
  QString lastReceiverError;

  QLabel *plainLabel(const QString &text, const char *name)
  {
    auto *label = new QLabel(text, this);
    label->setObjectName(name);
    label->setTextFormat(Qt::PlainText);
    label->setWordWrap(true);
    label->setTextInteractionFlags(Qt::TextSelectableByMouse);
    return label;
  }

  QLineEdit *textInput(const char *name, const QString &placeholder, int maximumLength)
  {
    auto *input = new QLineEdit(this);
    input->setObjectName(name);
    input->setPlaceholderText(placeholder);
    input->setMaxLength(maximumLength);
    input->setClearButtonEnabled(true);
    return input;
  }

  QWidget *createTokenField()
  {
    auto *field = new QWidget(this);
    auto *layout = new QHBoxLayout(field);
    layout->setContentsMargins(0, 0, 0, 0);
    tokenInput = textInput("vcMixToken", "Enter your bot token", 512);
    tokenInput->setEchoMode(QLineEdit::Password);
    tokenInput->setClearButtonEnabled(false);
    auto *showToken = new QCheckBox("Show", field);
    showToken->setObjectName("vcMixShowToken");
    connect(showToken, &QCheckBox::toggled, this, [this](bool visible) {
      tokenInput->setEchoMode(visible ? QLineEdit::Normal : QLineEdit::Password);
    });
    layout->addWidget(tokenInput, 1);
    layout->addWidget(showToken);
    return field;
  }

  QGroupBox *createConnectionGroup()
  {
    auto *group = new QGroupBox("Connection", this);
    auto *form = new QFormLayout(group);
    form->setFieldGrowthPolicy(QFormLayout::AllNonFixedFieldsGrow);
    auto *tokenField = createTokenField();
    auto *tokenLabel = plainLabel("&Bot token", "vcMixTokenLabel");
    tokenLabel->setBuddy(tokenInput);
    form->addRow(tokenLabel, tokenField);
    auto *tokenHint = plainLabel("Saved tokens are encrypted for your Windows account.", "vcMixTokenHint");
    tokenHint->setProperty("class", "text-muted");
    form->addRow(QString{}, tokenHint);
    guildInput = textInput("vcMixGuild", "Discord server ID", 20);
    channelInput = textInput("vcMixChannel", "Discord voice channel ID", 20);
    excludedInput = textInput("vcMixExcluded", "Optional: user IDs separated by commas", 2200);
    form->addRow("&Server ID", guildInput);
    form->addRow("&Voice channel ID", channelInput);
    form->addRow("&Excluded user IDs", excludedInput);
    autoConnect = new QCheckBox("Connect automatically when OBS starts", group);
    autoConnect->setObjectName("vcMixAutoConnect");
    form->addRow(QString{}, autoConnect);
    return group;
  }

  QPushButton *actionButton(const char *name, const QString &text, std::function<void()> action)
  {
    auto *button = new QPushButton(text, this);
    button->setObjectName(name);
    connect(button, &QPushButton::clicked, this, [this, action = std::move(action)] {
      try { action(); }
      catch (const std::exception &error) { showFeedback(QString::fromUtf8(error.what()), true); }
    });
    return button;
  }

  QHBoxLayout *createConnectionActions()
  {
    auto *layout = new QHBoxLayout;
    saveButton = actionButton("vcMixSave", "Save settings", [this] { saveConnection(false); });
    connectButton = actionButton("vcMixConnect", "Save && connect", [this] { saveConnection(true); });
    connectButton->setDefault(true);
    layout->addWidget(saveButton);
    layout->addWidget(connectButton);
    layout->addStretch();
    layout->addWidget(actionButton("vcMixDisconnect", "Disconnect", [this] {
      receiver().command("disconnect"); showFeedback({});
    }));
    layout->addWidget(actionButton("vcMixTest", "Test audio", [this] {
      ensureReceiverRunning(); receiver().command("test"); showFeedback({});
    }));
    return layout;
  }

  QGroupBox *createParticipantsGroup()
  {
    auto *group = new QGroupBox("Participants", this);
    auto *layout = new QVBoxLayout(group);
    auto *hint = plainLabel("Select a person to add their separate audio source to the current scene.", "vcMixParticipantsHint");
    hint->setProperty("class", "text-muted");
    layout->addWidget(hint);
    participantViews = new QStackedWidget(group);
    participantViews->setMinimumHeight(150);
    auto *emptyState = plainLabel("No participants yet.\nConnect to a voice channel or use Test audio.", "vcMixEmptyParticipants");
    emptyState->setAlignment(Qt::AlignCenter);
    emptyState->setProperty("class", "text-muted");
    participantViews->addWidget(emptyState);
    participantList = new QTreeWidget(group);
    participantList->setObjectName("vcMixParticipants");
    participantList->setHeaderLabels({"Participant", "User ID", "Packets"});
    participantList->setRootIsDecorated(false);
    participantList->setUniformRowHeights(true);
    participantList->setSelectionMode(QAbstractItemView::SingleSelection);
    participantList->header()->setStretchLastSection(false);
    participantList->header()->setSectionResizeMode(0, QHeaderView::Stretch);
    participantList->header()->setSectionResizeMode(1, QHeaderView::ResizeToContents);
    participantList->header()->setSectionResizeMode(2, QHeaderView::ResizeToContents);
    connect(participantList, &QTreeWidget::itemSelectionChanged, this, [this] {
      if (addSourceButton) addSourceButton->setEnabled(participantList->currentItem() != nullptr);
    });
    participantViews->addWidget(participantList);
    layout->addWidget(participantViews, 1);
    return group;
  }

  QHBoxLayout *createFooter()
  {
    auto *layout = new QHBoxLayout;
    addSourceButton = actionButton("vcMixAddSource", "Add selected to current scene", [this] { addSelectedSource(); });
    layout->addWidget(addSourceButton);
    layout->addStretch();
    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Close, this);
    buttons->button(QDialogButtonBox::Close)->setObjectName("vcMixClose");
    connect(buttons, &QDialogButtonBox::rejected, this, &QWidget::close);
    layout->addWidget(buttons);
    return layout;
  }

  void loadSettings()
  {
    const auto &settings = connectionSettings();
    tokenInput->setText(QString::fromStdString(settings.token));
    guildInput->setText(QString::fromStdString(settings.guildId));
    channelInput->setText(QString::fromStdString(settings.channelId));
    excludedInput->setText(QString::fromStdString(settings.excludedIds));
    autoConnect->setChecked(settings.autoConnect);
  }

  void saveConnection(bool connectAfterSave)
  {
    const ConnectionSettings settings{tokenInput->text().toStdString(), guildInput->text().toStdString(),
      channelInput->text().toStdString(), excludedInput->text().toStdString(), autoConnect->isChecked()};
    if (connectAfterSave || settings.autoConnect) validateSettings(settings);
    persistSettings(settings);
    if (connectAfterSave) {
      ensureReceiverRunning();
      receiver().connect(settings);
      showFeedback({});
      return;
    }
    showFeedback("Settings saved.");
  }

  void showFeedback(const QString &message, bool isError = false)
  {
    feedbackLabel->setText(message);
    feedbackLabel->setProperty("class", isError ? "text-danger" : "text-muted");
    // OBS themes style these classes; repolish after changing the feedback role.
    feedbackLabel->style()->unpolish(feedbackLabel);
    feedbackLabel->style()->polish(feedbackLabel);
    feedbackLabel->setVisible(!message.isEmpty());
  }

  void refreshParticipants(const std::vector<Participant> &participants)
  {
    const auto *selected = participantList->currentItem();
    const auto selectedId = selected ? selected->data(0, PARTICIPANT_ID_ROLE).toString() : QString{};
    QTreeWidgetItem *nextSelection = nullptr;
    int row = 0;
    for (const auto &participant : participants) {
      auto *item = participantList->topLevelItem(row++);
      if (!item) item = new QTreeWidgetItem(participantList);
      const auto userId = QString::fromStdString(participant.userId);
      item->setData(0, PARTICIPANT_ID_ROLE, userId);
      item->setText(0, QString::fromStdString(participant.name));
      item->setText(1, userId);
      item->setText(2, QString::number(participant.packets));
      item->setTextAlignment(2, Qt::AlignRight | Qt::AlignVCenter);
      if (userId == selectedId) nextSelection = item;
    }
    while (participantList->topLevelItemCount() > row) delete participantList->takeTopLevelItem(row);
    if (!nextSelection && row > 0) nextSelection = participantList->topLevelItem(0);
    participantList->setCurrentItem(nextSelection);
    participantViews->setCurrentIndex(participants.empty() ? 0 : 1);
    addSourceButton->setEnabled(nextSelection != nullptr);
  }

  void refreshStatus()
  {
    const auto snapshot = receiver().snapshot();
    statusLabel->setText(QString::fromStdString(snapshot.status));
    const auto receiverError = QString::fromStdString(snapshot.error);
    if (receiverError != lastReceiverError) {
      if (!receiverError.isEmpty()) showFeedback(receiverError, true);
      else if (feedbackLabel->text() == lastReceiverError) showFeedback({});
      lastReceiverError = receiverError;
    }
    refreshParticipants(snapshot.participants);
  }

  void addSelectedSource()
  {
    const auto *participant = participantList->currentItem();
    if (!participant) return;
    addParticipantToCurrentScene(participant->data(0, PARTICIPANT_ID_ROLE).toString().toStdString(),
      participant->text(0).toStdString());
    showFeedback("Added " + participant->text(0) + " to the current scene.");
  }
};

QPointer<SettingsDialog> settingsWindow;
}

void showSettingsWindow()
{
  if (!settingsWindow) {
    try { ensureReceiverRunning(); }
    catch (const std::exception &error) { blog(LOG_WARNING, "[vc-mix] %s", error.what()); }
    // Parenting to OBS's Qt window inherits its application theme and keeps this dialog modeless.
    settingsWindow = new SettingsDialog(static_cast<QWidget *>(obs_frontend_get_main_window()));
  }
  settingsWindow->showNormal();
  settingsWindow->raise();
  settingsWindow->activateWindow();
}

void closeSettingsWindow()
{
  // Delete synchronously before OBS unloads the plugin's code; WA_DeleteOnClose covers normal closes.
  delete settingsWindow.data();
}

bool settingsWindowHealthy() { return settingsWindow && settingsWindow->healthy(); }
