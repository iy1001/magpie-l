// Package all registers every built-in plugin. Only magpie's main imports
// it: core never imports a plugin, and a plugin never imports another.
//
// The Sessions and Library pages are left out: their packages are still
// here and their engines (internal/sessions, internal/library) still run,
// but neither page is drawn. Put their two imports back to bring them in.
package all

import (
	_ "github.com/yetone/magpie/plugins/budget"
	_ "github.com/yetone/magpie/plugins/gateway"
	_ "github.com/yetone/magpie/plugins/groups"
	_ "github.com/yetone/magpie/plugins/middleware"
	_ "github.com/yetone/magpie/plugins/otel"
	_ "github.com/yetone/magpie/plugins/redact"
	_ "github.com/yetone/magpie/plugins/rotation"
	_ "github.com/yetone/magpie/plugins/routing"
	_ "github.com/yetone/magpie/plugins/search"
	_ "github.com/yetone/magpie/plugins/tools"
	_ "github.com/yetone/magpie/plugins/usage"
	_ "github.com/yetone/magpie/plugins/warmups"
)
