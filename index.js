'use strict'

exports.register = function () {
  this.load_message-stream_ini()
}

exports.load_message-stream_ini = function () {
  const plugin = this

  plugin.cfg = plugin.config.get('message-stream.ini', {
    booleans: [
      '+enabled',               // plugin.cfg.main.enabled=true
      '-disabled',              // plugin.cfg.main.disabled=false
      '+feature_section.yes'    // plugin.cfg.feature_section.yes=true
    ]
  },
  function () {
    plugin.load_example_ini()
  })
}
