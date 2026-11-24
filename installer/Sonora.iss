; Instalador de Sonora (Inno Setup 6)
; Se compila con tools\make-installer.ps1, que primero publica la app en installer\out\app
; Uso manual:  ISCC.exe /DAppVersion=1.0.2 /DArch=x64 installer\Sonora.iss

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef Arch
  #define Arch "x64"
#endif
#ifndef SourceDir
  #define SourceDir "out\app"
#endif

[Setup]
AppId={{6B1F3C2A-8E54-4D7B-9A1E-50A0C0DE5A01}
AppName=Sonora
AppVersion={#AppVersion}
AppVerName=Sonora {#AppVersion}
AppPublisher=Adrián Díaz Serna
AppPublisherURL=https://github.com/adriandiazserna/Sonora
AppSupportURL=https://github.com/adriandiazserna/Sonora/issues
AppUpdatesURL=https://github.com/adriandiazserna/Sonora/releases
; Instalación por usuario: no pide permisos de administrador (se puede cambiar en el asistente)
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\Sonora
DefaultGroupName=Sonora
DisableProgramGroupPage=yes
OutputDir=out
OutputBaseFilename=Sonora-{#AppVersion}-{#Arch}-Setup
SetupIconFile=..\assets\sonora.ico
UninstallDisplayIcon={app}\Sonora.exe
UninstallDisplayName=Sonora
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
MinVersion=10.0
#if Arch == "x64"
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif
; Cierra Sonora si está abierto al instalar/actualizar
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Sonora"; Filename: "{app}\Sonora.exe"; WorkingDir: "{app}"
Name: "{group}\{cm:UninstallProgram,Sonora}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Sonora"; Filename: "{app}\Sonora.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Sonora.exe"; Description: "{cm:LaunchProgram,Sonora}"; Flags: nowait postinstall skipifsilent

[Code]
// WebView2 Runtime: viene con Windows 11; en Windows 10 puede faltar.
const
  WV2Key = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WV2Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

var
  DownloadPage: TDownloadWizardPage;

function WebView2Installed(): Boolean;
var
  v: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') and (v <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM, WV2Key, 'pv', v) and (v <> '') and (v <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, WV2Key, 'pv', v) and (v <> '') and (v <> '0.0.0.0'));
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), 'Descargando WebView2 Runtime (lo necesita Sonora)...', nil);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  rc: Integer;
begin
  Result := True;
  if (CurPageID = wpReady) and (not WebView2Installed()) then
  begin
    DownloadPage.Clear;
    DownloadPage.Add(WV2Url, 'MicrosoftEdgeWebview2Setup.exe', '');
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
        Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, rc);
      except
        MsgBox('No se pudo instalar WebView2 automáticamente. Sonora se instalará igual; si no abre, instálalo desde https://developer.microsoft.com/microsoft-edge/webview2/', mbInformation, MB_OK);
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;
