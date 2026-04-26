for i = 1, 5 do
  print(i, i * i)
end

local s = 0
for j = 10, 1, -2 do
  s = s + j
end
print("sum", s)

local n = 0
while n < 3 do
  print("while", n)
  n = n + 1
end

local t = {}
for i = 1, 3 do t[i] = i * 10 end
for k, v in ipairs(t) do
  print("ipairs", k, v)
end
