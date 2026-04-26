local t = {1, 2, 3, foo = "bar"}
print(t[1], t[2], t[3], t.foo)

t.baz = 42
print(t.baz)

local mt = { __index = function(_, k) return "default:" .. k end }
local u = setmetatable({x=10}, mt)
print(u.x, u.missing)

local arr = {}
for i = 1, 5 do table.insert(arr, i * 2) end
print(table.concat(arr, ","))
