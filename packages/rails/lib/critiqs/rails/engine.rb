# frozen_string_literal: true

require "rails/engine"
require "critiqs/rails/helper"

module Critiqs
  module Rails
    # Adds `critiqs_tag` to every view. Its app/assets/javascripts holds
    # critiqs/element.js and critiqs/context.js, which Propshaft and Sprockets
    # both pick up from an engine's app/assets folders; the page loads each
    # with its own <script type="module">, so importmap apps need no pin.
    class Engine < ::Rails::Engine
      initializer "critiqs.helper" do
        ActiveSupport.on_load(:action_view) { include Critiqs::Rails::Helper }
      end

      # Sprockets compiles only what it is told to; Propshaft serves every file
      # on its load path and has no precompile list.
      initializer "critiqs.assets" do |app|
        precompile = app.config.respond_to?(:assets) ? app.config.assets.precompile : nil
        precompile.push(ELEMENT_ASSET, CONTEXT_ASSET) if precompile.is_a?(Array)
      end
    end
  end
end
