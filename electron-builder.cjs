module.exports={
  appId:'au.tuneworkshop.desktop',productName:'Tuner Workshop',
  directories:{output:'dist',buildResources:'build'},
  asar:true,asarUnpack:['node_modules/@serialport/bindings-cpp/**'],npmRebuild:false,
  extraMetadata:{description:'Windows calibration editor and Fiat diagnostics workspace'},
  files:['fiat-modules.mjs','fiat-module-data.mjs','module-transport.mjs','module-session-actions.mjs','module-service.mjs','module-service-data.mjs','module-diagnostics.mjs','module-diagnostics-data.mjs','diagnostics-ui.mjs','diagnostics.css','diagnostic-actions.mjs','obd-diagnostics.mjs','fiat-diagnostics.mjs','fiat-diagnostics-data.mjs','service-tools.mjs','service-tools-data.mjs','instrument-service.mjs','docs/diagnostics-coverage.md','pressure-units.mjs','winols-project.mjs','map-identification.mjs','map-catalogue.mjs','map-catalogue.css','map-workbench.mjs','map-workbench-model.mjs','map-workbench.css','map-references.mjs','map-reference-data.mjs','fiat-8gmk.mjs','fiat-8gmk-data.mjs','can-diagnostics.mjs','diagnostic-catalog.mjs','dimsport-ui.mjs','calibration-discovery.mjs','settings-schema.mjs','settings-client.mjs','settings-ui.mjs','settings.css','chat-keyboard.mjs','ports.mjs','elm-protocol.mjs','sensor-session.mjs','sensor-events.mjs','ble.mjs','bluetooth-ui.mjs','package.json','index.html','styles.css','live.css','app.mjs','live.mjs','core.mjs','formats.mjs','mes-log.mjs','chat-history.mjs','elm.mjs','assistant.mjs','server.mjs','desktop/*.mjs','desktop/preload.cjs','build/icon.ico','README.md'],
  win:{target:[{target:'portable',arch:['x64']},{target:'nsis',arch:['x64']}],icon:'build/icon.ico',signAndEditExecutable:true},
  portable:{artifactName:'Tuner-Workshop-${version}-Windows-x64.exe',requestExecutionLevel:'user'},
  nsis:{artifactName:'Tuner-Workshop-${version}-Setup-x64.exe',oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,createStartMenuShortcut:true,runAfterFinish:false,deleteAppDataOnUninstall:false},
  publish:null
};
