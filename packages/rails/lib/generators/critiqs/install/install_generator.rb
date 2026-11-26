# frozen_string_literal: true

require "bundler"
require "prism"
require "rails/generators"

module Critiqs
  module Generators
    # bin/rails generate critiqs:install
    class InstallGenerator < ::Rails::Generators::Base
      LAYOUT = "app/views/layouts/application.html.erb"
      GEM = "critiqs-rails"
      TAG = "<%= critiqs_tag %>"
      # ERB as Rails's Erubi reads it: a tag runs from <% to the first %>,
      # whatever the Ruby inside says. <%# is a comment and <%% writes <%.
      ERB_TAG = /<%(={1,2}|-|\#|%)?(.*?)[-=]?%>/m

      desc "Adds <%= critiqs_tag %> to #{LAYOUT}, just before </body>."

      def add_tag
        if (problem = gem_problem)
          @refused = true
          say_status :skip, "#{problem} Production would fail on pages calling critiqs_tag, so #{LAYOUT} wasn't changed. " \
                            "Declare gem \"critiqs-rails\" at the top level of the Gemfile, outside any group or condition, with no platforms or require: false, " \
                            "run bundle install, then run this generator again.", :red
          return
        end
        if (view = view_with_tag)
          say_status :identical, "#{view} already has critiqs_tag", :blue
          return
        end
        path = File.join(destination_root, LAYOUT)
        unless File.exist?(path)
          say_status :skip, "#{LAYOUT} not found. Add #{TAG} just before </body> in your layout.", :yellow
          return
        end
        source = File.read(path)
        if source.gsub(ERB_TAG, "").include?("<%")
          say_status :skip, "#{LAYOUT} has an ERB tag (<%) that never closes. Add #{TAG} just before </body>.", :yellow
          return
        end
        tags = erb_tags(source)
        closings = markup_only(source, tags).to_enum(:scan, %r{</body\s*>}i).map { Regexp.last_match.begin(0) }
        unless closings.size == 1
          say_status :skip, "#{LAYOUT} has #{closings.size} </body> tags outside ERB code, comments and scripts. Add #{TAG} just before the right one.", :yellow
          return
        end
        File.binwrite(path, insertion(source, closings.first)) unless options[:pretend]
        say_status :insert, LAYOUT
      end

      def next_steps
        return if @refused

        say ""
        say "Critiqs appears where CRITIQS_PROJECT_ID is set to your project's ID, and nowhere else."
        say "Set it in each environment that should show Critiqs, then restart the server."
      end

      private

      # Bundler's DSL, also noting where each critiqs-rails declaration is
      # (file and line) and whether an install_if wraps it, which Bundler
      # reduces to whether this computer meets it now.
      class GemfileReader < ::Bundler::Dsl
        attr_reader :declaration

        def install_if(*)
          @install_ifs = (@install_ifs || 0) + 1
          super
        ensure
          @install_ifs -= 1
        end

        def gem(name, *args)
          if name == GEM
            options = args.last.is_a?(Hash) ? args.last : {}
            location = caller_locations(1, 1).first
            install_if = (@install_ifs || 0).positive? || options.key?(:install_if) || options.key?("install_if")
            @declaration = { path: location.path, line: location.lineno, install_if: install_if }
          end
          super
        end
      end

      # Code around a gem declaration that decides whether it runs, or a block
      # Bundler scopes it to; `group` blocks are judged from Bundler's result.
      CONDITIONS = {
        Prism::IfNode => "under an if", Prism::UnlessNode => "under an unless", Prism::CaseNode => "in a case",
        Prism::CaseMatchNode => "in a case", Prism::WhileNode => "in a while", Prism::UntilNode => "in an until",
        Prism::AndNode => "after an and", Prism::OrNode => "after an or", Prism::RescueNode => "in a rescue",
        Prism::DefNode => "inside a method", Prism::LambdaNode => "inside a lambda",
      }.freeze
      UNSCOPED_BLOCKS = %i[source git github path group].freeze

      # Why the declaration at `path`:`line` might not run in production, read
      # from its file with Prism, or nil.
      def condition_around(path, line)
        result = Prism.parse_file(path)
        where = "#{File.basename(path)}:#{line}"
        return "in code setup can't parse (#{where})" unless result.success?

        ancestors = declaration_ancestors(result.value, line, [])
        return "in a way setup can't find in #{where}" if ancestors.nil?

        ancestors.reverse_each do |node|
          condition = CONDITIONS.find { |type, _| node.is_a?(type) }&.last
          condition ||= "inside `#{node.name}`" if node.is_a?(Prism::CallNode) && !UNSCOPED_BLOCKS.include?(node.name)
          return "#{condition} (#{where})" if condition
        end
        nil
      end

      # The nodes around the `gem "critiqs-rails"` call on `line`, outermost first, or nil.
      def declaration_ancestors(node, line, ancestors)
        if node.is_a?(Prism::CallNode) && node.name == :gem && node.receiver.nil? && node.location.start_line == line &&
           node.arguments&.arguments&.first.then { _1.is_a?(Prism::StringNode) && _1.unescaped == GEM }
          return ancestors
        end

        ancestors.push(node)
        node.compact_child_nodes.each do |child|
          found = declaration_ancestors(child, line, ancestors)
          return found if found
        end
        ancestors.pop
        nil
      end

      # The ERB tags in a template.
      def erb_tags(source) = source.to_enum(:scan, ERB_TAG).map { Regexp.last_match }

      # The first view under app/views (layouts and the partials they render
      # among them) that already calls critiqs_tag outside comments, relative
      # to the app, or nil.
      def view_with_tag
        views = Dir.glob("app/views/**/*.{erb,haml,slim}", base: destination_root).sort
        views.find do |view|
          source = File.read(File.join(destination_root, view))
          if view.end_with?(".erb")
            erb_tags(source).any? { |tag| !["#", "%"].include?(tag[1]) && tag[2].match?(/\bcritiqs_tag\b/) }
          else
            source.each_line.any? { |line| line.match?(/\bcritiqs_tag\b/) && !line.match?(%r{\A\s*(?:-#|/)}) }
          end
        end
      end

      # Why production might not load critiqs_tag, read from the app's Gemfile
      # the way Bundler reads it, or nil. Production apps usually install
      # without the development and test groups (BUNDLE_WITHOUT), and Rails
      # requires only the default group's gems that don't say require: false.
      def gem_problem
        gemfile = %w[Gemfile gems.rb].map { File.join(destination_root, _1) }.find { File.exist?(_1) }
        return "There's no Gemfile in #{destination_root}." unless gemfile

        dsl = GemfileReader.new
        dsl.eval_gemfile(gemfile)
        gem = dsl.dependencies.find { _1.name == GEM }
        name = File.basename(gemfile)
        if gem.nil?
          "#{name} doesn't declare critiqs-rails."
        elsif !gem.groups.include?(:default)
          "#{name} declares critiqs-rails only in the #{gem.groups.join(", ")} group#{"s" if gem.groups.size > 1}."
        elsif gem.platforms.any?
          "#{name} declares critiqs-rails only for the #{gem.platforms.join(", ")} platform#{"s" if gem.platforms.size > 1}."
        elsif gem.autorequire == []
          "#{name} declares critiqs-rails with require: false, so Rails doesn't load it."
        elsif !gem.should_include?
          "#{name} installs critiqs-rails only under a condition (install_if or env) this computer doesn't meet."
        elsif gem.env
          "#{name} declares critiqs-rails only where #{gem.env.inspect} is set in the environment (an env block)."
        elsif dsl.declaration&.fetch(:install_if)
          "#{name} installs critiqs-rails only under an install_if condition, which production might not meet."
        elsif dsl.declaration.nil?
          "Setup couldn't tell where #{name} declares critiqs-rails."
        elsif (condition = condition_around(dsl.declaration[:path], dsl.declaration[:line]))
          "#{name} declares critiqs-rails #{condition}, so production might not load it."
        end
      rescue ScriptError, StandardError => e
        "Bundler couldn't read the Gemfile (#{e.message.lines.first.to_s.strip})."
      end

      # The layout with ERB tags, HTML comments, quoted attribute values and
      # the contents of script, style, textarea and title blanked out, same
      # length and lines, so what's left is the page's markup.
      def markup_only(source, tags)
        markup = source.dup
        tags.each { |tag| markup[tag.begin(0)...tag.end(0)] = blank(tag[0]) }
        markup.gsub(%r{<!--.*?(?:-->|\z)|(<(script|style|textarea|title)\b(?:"[^"]*"|'[^']*'|[^>"'])*>)(.*?)(?=</\2\s*>|\z)|<[a-z][^\s/>]*(?:"[^"]*"|'[^']*'|[^>"'])*>}mi) do
          match = Regexp.last_match
          if match[1] then blank_values(match[1]) + blank(match[3])
          elsif match[0].start_with?("<!--") then blank(match[0])
          else blank_values(match[0])
          end
        end
      end

      def blank(text) = text.gsub(/[^\r\n]/, " ")

      def blank_values(tag) = tag.gsub(/"[^"]*"|'[^']*'/) { |value| value[0] + blank(value[1...-1]) + value[0] }

      # The tag on its own line before the </body> at `at`, indented like the
      # body's other children, or right before it when it shares a line with
      # markup.
      def insertion(source, at)
        line_start = at.zero? ? 0 : (source.rindex("\n", at - 1) || -1) + 1
        indent = source[line_start...at]
        return source.dup.insert(at, TAG) unless indent.match?(/\A[ \t]*\z/)

        before = source[0...line_start].split(/\r?\n/).reverse.find { |line| !line.strip.empty? }.to_s
        previous = before[/\A[ \t]*/]
        child = previous.length > indent.length ? previous : "#{indent}#{indent.include?("\t") ? "\t" : "  "}"
        newline = source.include?("\r\n") ? "\r\n" : "\n"
        "#{source[0...line_start]}#{child}#{TAG}#{newline}#{source[line_start..]}"
      end
    end
  end
end
