document.addEventListener('alpine:init', () => {
	// 将图表实例放在 Alpine 响应式系统之外，避免深度监听导致的栈溢出
	const charts = { monthly: null, hourly: null, category: null };

	Alpine.data('expenseApp', () => ({
		records: [],
		isProcessing: false,
		progress: 0,
		statusText: '准备就绪',
		hourlyMode: 'count', // 'count' 或 'amount'
		displayLimit: 50,    // 初始显示 50 条

		async init() {
			// 优先从 IndexedDB 加载
			try {
				let data = await db.getAll();
				if (data && data.length > 0) {
					// 自动归一化旧数据格式 (例如将 2025/01/01 转换为 2025-01-01)
					let hasChanged = false;
					data = data.map(r => {
						const oldTime = r.time;
						let newTime = r.time.replace(/\//g, '-');
						const parts = newTime.split(' ');
						const dateParts = parts[0].split('-');
						if (dateParts.length === 3) {
							dateParts[1] = dateParts[1].padStart(2, '0');
							dateParts[2] = dateParts[2].padStart(2, '0');
							parts[0] = dateParts.join('-');
						}
						newTime = parts.join(' ');
						if (newTime !== oldTime) {
							r.time = newTime;
							hasChanged = true;
						}
						return r;
					});
					if (hasChanged) await db.saveAll(data);
					this.records = data;
				} else {
					// 兼容旧版 localStorage
					const stored = localStorage.getItem('my_expense_data');
					if (stored) {
						this.records = JSON.parse(stored);
						await db.saveAll(this.records);
						localStorage.removeItem('my_expense_data'); // 迁移后删除
					}
				}
			} catch (e) { console.error('DB Init Error:', e); }

			// 监听数据变化更新图表
			this.$watch('records', () => {
				 this.$nextTick(() => this.updateCharts());
			});
			this.$watch('hourlyMode', () => {
				 this.renderHourlyChart();
			});
			// 首次加载如果有数据也渲染
			if(this.records.length > 0) {
				 this.$nextTick(() => this.updateCharts());
			}
		},

		// --- 计算属性 ---
		get sortedRecords() {
			return [...this.records].sort((a, b) => new Date(b.time) - new Date(a.time));
		},

		get limitedRecords() {
			return this.sortedRecords.slice(0, this.displayLimit);
		},

		get totalAmount() {
			return this.records.reduce((sum, item) => sum + parseFloat(item.amount || 0), 0);
		},

		get dailyTotals() {
				const totals = {};
				this.records.forEach(r => {
						const date = r.time.split(' ')[0];
						totals[date] = (totals[date] || 0) + r.amount;
				});
				return totals;
		},

		get maxDailyAmount() {
				const totals = Object.values(this.dailyTotals);
				return totals.length > 0 ? Math.max(...totals) : 0;
		},

		get heatmapDays() {
				const days = [];
				const today = new Date();
				// 生成最近 365 天的数据
				for (let i = 364; i >= 0; i--) {
						const d = new Date();
						d.setDate(today.getDate() - i);
						const dateStr = d.toISOString().split('T')[0];
						days.push({
								date: dateStr,
								amount: this.dailyTotals[dateStr] || 0
						});
				}
				return days;
		},

		get uniqueMonths() {
				const months = new Set(this.records.map(r => r.time.substring(0, 7))); // YYYY-MM
				return Array.from(months).sort();
		},

		get monthlyAverage() {
				if (this.uniqueMonths.length === 0) return '0.00';
				// 简单平均：总金额 / 月份数量
				// 注意：虽然用户说最新月份不完整，但为了数学逻辑闭环，直接平均是比较通用的展示
				return (this.totalAmount / this.uniqueMonths.length).toFixed(2);
		},

		get topCategory() {
				if (this.records.length === 0) return { name: '无', percent: 0 };
				const counts = {};
				this.records.forEach(r => { counts[r.type] = (counts[r.type] || 0) + 1; });
				const top = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
				const percent = Math.round((counts[top] / this.records.length) * 100);
				return { name: top, percent: percent };
		},

		// --- 样式工具 ---
		getTypeColor(type) {
				const map = {
						'饮水': 'bg-blue-100 text-blue-600',
						'洗浴': 'bg-purple-100 text-purple-600',
						'吹风': 'bg-yellow-100 text-yellow-600',
						'洗衣': 'bg-green-100 text-green-600',
				};
				return map[type] || 'bg-gray-100 text-gray-600';
		},

		getHeatmapColor(amount) {
				if (!amount || amount === 0) return 'bg-gray-100';
				const max = this.maxDailyAmount;
				if (max === 0) return 'bg-gray-100';
				
				const ratio = amount / max;
				if (ratio <= 0.25) return 'bg-green-200';
				if (ratio <= 0.5) return 'bg-green-400';
				if (ratio <= 0.75) return 'bg-green-600';
				return 'bg-green-800';
		},

		// --- 核心业务：OCR ---
		async handleFileUpload(e) {
			const files = e.target.files;
			if (!files.length) return;
			this.isProcessing = true;
			this.progress = 0;
			let newCount = 0;

			try {
				this.statusText = '正在智能切分图片...';
				
				// 1. 并行切分所有图片
				const allChunks = [];
				for (let file of files) {
					const chunks = await this.splitImage(file);
					allChunks.push(...chunks);
				}

				this.statusText = `准备识别 (共 ${allChunks.length} 个分段)...`;
				
				// 2. 初始化并行识别 (手动管理以精确控制进度)
				const workerCount = Math.min(4, allChunks.length);
				const workerProgress = new Array(workerCount).fill(0);
				let completedChunks = 0;
				const workers = [];

				for (let i = 0; i < workerCount; i++) {
					const worker = await Tesseract.createWorker('chi_sim+eng', 1, {
						logger: m => { 
							if(m.status === 'recognizing text') {
								workerProgress[i] = m.progress || 0;
								const currentTotal = completedChunks + workerProgress.reduce((a, b) => a + b, 0);
								const newProgress = Math.min(0.99, currentTotal / allChunks.length);
								this.progress = Math.max(this.progress, newProgress);
							}
						},
						langPath: 'https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_best/',
						corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js',
						workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js'
					});
					workers.push({ worker, id: i });
				}

				// 3. 执行并行识别任务
				const existingTimes = new Set(this.records.map(r => r.time));
				const chunkQueue = [...allChunks];
				const results = [];

				const processQueue = async (wInfo) => {
					while (chunkQueue.length > 0) {
						const chunk = chunkQueue.shift();
						if (!chunk) break;
						const ret = await wInfo.worker.recognize(chunk);
						
						// 关键：完成后立即重置该 worker 的进度贡献，避免与 completedChunks 双重计算
						workerProgress[wInfo.id] = 0;
						completedChunks++;
						
						const newProgress = Math.min(0.99, completedChunks / allChunks.length);
						this.progress = Math.max(this.progress, newProgress);
						results.push(this.parseAndMerge(ret.data.text, existingTimes));
					}
				};

				// 启动所有 Worker 并行处理队列
				await Promise.all(workers.map(w => processQueue(w)));

				// 4. 统一合并结果，触发一次视图更新
				const allNewRecords = results.flat();
				if (allNewRecords.length > 0) {
					this.records = this.records.concat(allNewRecords);
				}
				newCount = allNewRecords.length;
				
				this.progress = 1; 
				for (let wInfo of workers) {
					await wInfo.worker.terminate();
				}
				this.saveToStorage();
				
				if (newCount > 0) {
					alert(`识别完成！新增 ${newCount} 条记录。`);
				} else {
					alert('识别完成，未发现新记录。');
				}
			} catch (err) {
				console.error(err);
				alert('识别出错: ' + err.message);
			} finally {
				this.isProcessing = false;
				e.target.value = '';
			}
		},

		// 智能切分图片：寻找 4000px 附近的空白行
		async splitImage(file) {
			return new Promise((resolve) => {
				const reader = new FileReader();
				reader.onload = (e) => {
					const img = new Image();
					img.onload = () => {
						const chunks = [];
						const canvas = document.createElement('canvas');
						const ctx = canvas.getContext('2d', { willReadFrequently: true });
						const width = img.width;
						const totalHeight = img.height;
						const targetHeight = 4000; // 目标切分高度

						let currentY = 0;
						while (currentY < totalHeight) {
							let nextY = Math.min(currentY + targetHeight, totalHeight);
							
							// 如果还没到末尾，尝试向下寻找空白行（避开文字）
							if (nextY < totalHeight) {
								nextY = this.findBestSplitPoint(img, nextY, totalHeight);
							}

							const chunkHeight = nextY - currentY;
							canvas.width = width;
							canvas.height = chunkHeight;
							ctx.drawImage(img, 0, currentY, width, chunkHeight, 0, 0, width, chunkHeight);
							
							chunks.push(canvas.toDataURL('image/jpeg', 0.85));
							currentY = nextY;
						}
						resolve(chunks);
					};
					img.src = e.target.result;
				};
				reader.readAsDataURL(file);
			});
		},

		// 在指定位置向下扫描，寻找颜色最统一的一行作为切分点（兼容黑夜模式）
		findBestSplitPoint(img, startY, totalHeight) {
			const scanRange = 400; // 向下扫描 400 像素寻找空隙
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('2d');
			canvas.width = img.width;
			canvas.height = scanRange;
			
			ctx.drawImage(img, 0, startY, img.width, scanRange, 0, 0, img.width, scanRange);
			const imageData = ctx.getImageData(0, 0, img.width, scanRange).data;

			let bestY = startY;
			let minVariance = Infinity;

			// 每隔 5 像素扫描一行，寻找颜色方差最小的一行（即纯色背景行）
			for (let y = 0; y < Math.min(scanRange, totalHeight - startY); y += 5) {
				let rSum = 0, gSum = 0, bSum = 0;
				const sampleCount = 20; // 每行采样 20 个点
				const step = Math.floor(img.width / sampleCount);
				
				const pixels = [];
				for (let x = 0; x < img.width; x += step) {
					const i = (y * img.width + x) * 4;
					pixels.push({r: imageData[i], g: imageData[i+1], b: imageData[i+2]});
				}

				// 计算这行采样点的颜色方差
				const avgR = pixels.reduce((s, p) => s + p.r, 0) / pixels.length;
				const avgG = pixels.reduce((s, p) => s + p.g, 0) / pixels.length;
				const avgB = pixels.reduce((s, p) => s + p.b, 0) / pixels.length;
				
				const variance = pixels.reduce((s, p) => {
					return s + Math.abs(p.r - avgR) + Math.abs(p.g - avgG) + Math.abs(p.b - avgB);
				}, 0);

				if (variance < minVariance) {
					minVariance = variance;
					bestY = startY + y;
				}
				// 如果方差极小，说明找到了完美的背景行，直接返回
				if (variance < 10) return startY + y;
			}
			return bestY;
		},

		parseAndMerge(text, existingTimes) {
			const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l);
			// 更加灵活的时间正则：支持 - 和 /，支持月日时单数字
			const timeRegex = /(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}:\d{2})/;
			const amountRegex = /-(\d+\.\d+)/;
			const typeRegex = /(饮水|洗浴|吹风|洗衣|消费|购物)/;
			const newRecords = [];

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const timeMatch = line.match(timeRegex);
				if (timeMatch) {
					let timeStr = timeMatch[1];
					
					// 归一化时间格式为 YYYY-MM-DD HH:mm:ss
					timeStr = timeStr.replace(/\//g, '-');
					const [datePart, timePart] = timeStr.split(' ');
					const [y, m, d] = datePart.split('-');
					const normalizedDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
					const [hh, mm, ss] = timePart.split(':');
					const normalizedTime = `${hh.padStart(2, '0')}:${mm}:${ss}`;
					timeStr = `${normalizedDate} ${normalizedTime}`;
					
					if (existingTimes.has(timeStr)) continue;

					let contextLines = [line];
					if (i > 0) contextLines.push(lines[i-1]);
					if (i > 1) contextLines.push(lines[i-2]);
					const contextStr = contextLines.join(' ');
					const amountMatch = contextStr.match(amountRegex);
					const typeMatch = contextStr.match(typeRegex);
					if (amountMatch) {
						const record = {
							time: timeStr,
							type: typeMatch ? typeMatch[1] : '其他',
							amount: parseFloat(amountMatch[1])
						};
						newRecords.push(record);
						existingTimes.add(timeStr);
					}
				}
			}
			return newRecords;
		},

		saveToStorage() {
			db.saveAll(this.records);
		},

		clearData() {
			if (confirm('确定要清空所有数据吗？')) {
				this.records = [];
				db.clear();
				// 销毁图表并重置引用
				if (charts.monthly) {
					charts.monthly.destroy();
					charts.monthly = null;
				}
				if (charts.hourly) {
					charts.hourly.destroy();
					charts.hourly = null;
				}
			}
		},

		// --- 导入导出功能 (修改后) ---
		
		// 辅助：下载文件
		downloadFile(content, fileName, mimeType) {
				const blob = new Blob([content], { type: mimeType });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = fileName;
				document.body.appendChild(a); a.click(); document.body.removeChild(a);
		},

		// 导出 JSON
		exportJson() {
				if (this.records.length === 0) { alert('没有数据'); return; }
				const grouped = {};
				const sorted = [...this.records].sort((a, b) => new Date(b.time) - new Date(a.time));
				sorted.forEach(item => {
						const monthKey = item.time.substring(0, 7);
						if (!grouped[monthKey]) grouped[monthKey] = [];
						grouped[monthKey].push(item);
				});
				this.downloadFile(JSON.stringify(grouped, null, 2), `expense_backup_${new Date().toISOString().split('T')[0]}.json`, "application/json");
		},

		// 导出 CSV
		exportCsv() {
				if (this.records.length === 0) { alert('没有数据'); return; }
				const sorted = [...this.records].sort((a, b) => new Date(b.time) - new Date(a.time));
				// CSV 头部
				let csvContent = "Time,Type,Amount\n";
				// CSV 内容
				sorted.forEach(item => {
						csvContent += `${item.time},${item.type},${item.amount}\n`;
				});
				// 添加 BOM (\uFEFF) 以解决 Excel 打开中文乱码问题
				this.downloadFile("\uFEFF" + csvContent, `expense_export_${new Date().toISOString().split('T')[0]}.csv`, "text/csv;charset=utf-8;");
		},

		// 统一处理导入
		handleImport(e) {
				const file = e.target.files[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = (event) => {
						const content = event.target.result;
						let newItems = [];
						
						try {
								// 尝试作为 JSON 解析
								if (file.name.toLowerCase().endsWith('.json')) {
										const importedData = JSON.parse(content);
										let itemsToProcess = [];
										if (Array.isArray(importedData)) {
												itemsToProcess = importedData;
										} else {
												Object.values(importedData).forEach(monthList => {
														if (Array.isArray(monthList)) itemsToProcess = itemsToProcess.concat(monthList);
												});
										}
										newItems = itemsToProcess.filter(item => item.time && item.amount !== undefined)
												.map(item => {
														// 归一化 JSON 中的时间格式
														let time = item.time.replace(/\//g, '-');
														const parts = time.split(' ');
														const dateParts = parts[0].split('-');
														if (dateParts.length === 3) {
																dateParts[1] = dateParts[1].padStart(2, '0');
																dateParts[2] = dateParts[2].padStart(2, '0');
																parts[0] = dateParts.join('-');
														}
														item.time = parts.join(' ');
														return item;
												});
								} 
								// 尝试作为 CSV 解析
								else if (file.name.toLowerCase().endsWith('.csv')) {
										// 移除可能存在的 BOM
										const csvContent = content.startsWith('\uFEFF') ? content.slice(1) : content;
										// 兼容多种换行符
										const lines = csvContent.split(/\r\n|\n|\r/);
										
										lines.forEach((line) => {
												// 简单的 CSV 解析：按逗号分割，并移除两端空格和引号
												const parts = line.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''));
												if (parts.length >= 3) {
														let time = parts[0];
														const type = parts[1];
														// 兼容逗号作为小数点的情况，并解析数字
														const amountStr = parts[2].replace(',', '.');
														const amount = parseFloat(amountStr);
														
														// 更加灵活的时间格式校验 (支持 YYYY-MM-DD 和 YYYY/MM/DD)
														if (time.match(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/) && !isNaN(amount)) {
																// 归一化时间格式
																time = time.replace(/\//g, '-');
																const parts = time.split(' ');
																const dateParts = parts[0].split('-');
																dateParts[1] = dateParts[1].padStart(2, '0');
																dateParts[2] = dateParts[2].padStart(2, '0');
																parts[0] = dateParts.join('-');
																time = parts.join(' ');

																newItems.push({ time, type, amount });
														}
												}
										});
								} else {
										alert("不支持的文件格式");
										return;
								}

								// 过滤掉已存在的记录并合并
								const existingTimes = new Set(this.records.map(r => r.time));
								const uniqueNewItems = newItems.filter(item => !existingTimes.has(item.time));
								
								if (uniqueNewItems.length > 0) {
										// 使用 concat 触发 Alpine.js 的数组响应式更新
										this.records = this.records.concat(uniqueNewItems);
										this.saveToStorage();
										alert(`导入成功：新增 ${uniqueNewItems.length} 条记录`);
								} else {
										alert('未发现新记录（可能已存在或格式不符）');
								}
						} catch (err) {
								console.error(err);
								alert('文件解析错误，请检查格式');
						} finally {
								e.target.value = '';
						}
				};
				// 默认使用 UTF-8 读取
				reader.readAsText(file);
		},

		// --- 图表渲染逻辑 ---
		updateCharts() {
				if (this.records.length === 0) return;

				this.renderMonthlyChart();
				this.renderCategoryChart();
				this.renderHourlyChart();
		},

		renderMonthlyChart() {
				const canvas = document.getElementById('monthlyChart');
				if (!canvas || canvas.offsetParent === null) return;

				const ctx = canvas.getContext('2d');
				if (!ctx) return;

				// 1. 数据准备
				const monthMap = {};
				this.uniqueMonths.forEach(m => monthMap[m] = 0);
				this.records.forEach(r => {
						const m = r.time.substring(0, 7);
						monthMap[m] += r.amount;
				});

				const labels = Object.keys(monthMap);
				const data = Object.values(monthMap);

				// 2. 如果图表已存在，则尝试更新数据
				if (charts.monthly) {
					try {
						charts.monthly.data.labels = labels;
						charts.monthly.data.datasets[0].data = data;
						charts.monthly.update('none');
						return;
					} catch (e) {
						// 如果更新失败（例如 Canvas 状态异常），销毁并准备重建
						charts.monthly.destroy();
						charts.monthly = null;
					}
				}

				// 3. 创建新图表
				charts.monthly = new Chart(canvas, {
						type: 'bar',
						data: {
								labels: labels,
								datasets: [{
										label: '月度总支出 (元)',
										data: data,
										backgroundColor: 'rgba(59, 130, 246, 0.6)',
										borderColor: 'rgb(59, 130, 246)',
										borderWidth: 1,
										borderRadius: 6
								}]
						},
						options: {
								responsive: true,
								maintainAspectRatio: false,
								animation: false, // 彻底禁用动画以解决渲染报错
								plugins: {
										legend: { display: false },
										tooltip: {
												callbacks: {
														label: (context) => {
																return `支出: ¥${context.parsed.y.toFixed(2)}`;
														}
												}
										}
								},
								scales: {
										y: { beginAtZero: true, grid: { borderDash: [2, 4] } },
										x: { grid: { display: false } }
								}
						}
				});
		},

		renderCategoryChart() {
				const canvas = document.getElementById('categoryChart');
				if (!canvas || canvas.offsetParent === null) return;

				const ctx = canvas.getContext('2d');
				if (!ctx) return;

				// 1. 数据准备
				const categories = ['饮水', '洗浴', '吹风', '洗衣', '其他'];
				const categoryMap = {};
				categories.forEach(c => categoryMap[c] = 0);

				this.records.forEach(r => {
						let type = r.type;
						if (!categoryMap.hasOwnProperty(type)) type = '其他';
						categoryMap[type] += r.amount;
				});

				const labels = Object.keys(categoryMap);
				const data = Object.values(categoryMap);
				const colors = [
						'rgba(59, 130, 246, 0.7)',  // 饮水 - 蓝色
						'rgba(147, 51, 234, 0.7)', // 洗浴 - 紫色
						'rgba(234, 179, 8, 0.7)',   // 吹风 - 黄色
						'rgba(34, 197, 94, 0.7)',   // 洗衣 - 绿色
						'rgba(156, 163, 175, 0.7)'  // 其他 - 灰色
				];

				// 2. 如果图表已存在，则尝试更新数据
				if (charts.category) {
					try {
						charts.category.data.labels = labels;
						charts.category.data.datasets[0].data = data;
						charts.category.update('none');
						return;
					} catch (e) {
						charts.category.destroy();
						charts.category = null;
					}
				}

				// 3. 创建新图表
				charts.category = new Chart(canvas, {
						type: 'doughnut',
						data: {
								labels: labels,
								datasets: [{
										data: data,
										backgroundColor: colors,
										borderWidth: 2,
										borderColor: '#ffffff'
								}]
						},
						options: {
								responsive: true,
								maintainAspectRatio: false,
								cutout: '60%',
								plugins: {
										legend: {
												position: 'bottom',
												labels: {
														boxWidth: 12,
														padding: 15,
														font: { size: 11 }
												}
										},
										tooltip: {
												callbacks: {
														label: (context) => {
																const value = context.parsed;
																const total = context.dataset.data.reduce((a, b) => a + b, 0);
																const percent = ((value / total) * 100).toFixed(1);
																return ` ${context.label}: ¥${value.toFixed(2)} (${percent}%)`;
														}
												}
										}
								}
						}
				});
		},

		renderHourlyChart() {
				const canvas = document.getElementById('hourlyChart');
				if (!canvas || canvas.offsetParent === null) return;

				const ctx = canvas.getContext('2d');
				if (!ctx) return;

				// 1. 数据准备 (按小时 0-23 分桶)
				const hours = Array.from({length: 24}, (_, i) => i);
				const categories = ['饮水', '洗浴', '吹风', '洗衣', '其他'];
				const mode = this.hourlyMode;

				const datasetsData = {};
				const countsData = {}; // 用于计算平均值
				categories.forEach(c => {
						datasetsData[c] = new Array(24).fill(0);
						countsData[c] = new Array(24).fill(0);
				});

				this.records.forEach(r => {
						const hour = new Date(r.time).getHours();
						let type = r.type;
						if (!datasetsData[type]) type = '其他';
						
						if (mode === 'count') {
								datasetsData[type][hour] += 1;
						} else if (mode === 'amount') {
								datasetsData[type][hour] += r.amount;
						} else if (mode === 'average') {
								datasetsData[type][hour] += r.amount;
								countsData[type][hour] += 1;
						}
				});

				// 如果是平均模式，执行除法
				if (mode === 'average') {
						categories.forEach(c => {
								for (let i = 0; i < 24; i++) {
										datasetsData[c][i] = countsData[c][i] > 0 ? (datasetsData[c][i] / countsData[c][i]) : 0;
								}
						});
				}

				const colors = {
						'饮水': 'rgba(59, 130, 246, 0.8)',
						'洗浴': 'rgba(147, 51, 234, 0.8)',
						'吹风': 'rgba(234, 179, 8, 0.8)',
						'洗衣': 'rgba(34, 197, 94, 0.8)',
						'其他': 'rgba(156, 163, 175, 0.5)'
				};

				const datasets = categories.map(c => ({
						label: c + (mode === 'count' ? ' (次)' : ' (元)'),
						data: datasetsData[c],
						backgroundColor: colors[c],
						stack: 'Stack 0', // 所有模式均使用堆叠，保证柱子宽度并显示构成
				}));

				// 2. 如果图表已存在，则尝试更新数据和配置
				if (charts.hourly) {
					try {
						charts.hourly.data.datasets = datasets;
						// 更新配置
						charts.hourly.options.scales.x.stacked = true;
						charts.hourly.options.scales.y.stacked = true;
						charts.hourly.options.scales.y.title.text = mode === 'count' ? '次数' : '金额 (元)';
						
						charts.hourly.update('none');
						return;
					} catch (e) {
						charts.hourly.destroy();
						charts.hourly = null;
					}
				}

				// 3. 创建新图表
				charts.hourly = new Chart(canvas, {
						type: 'bar',
						data: {
								labels: hours.map(h => `${h}点`),
								datasets: datasets
						},
						options: {
								responsive: true,
								maintainAspectRatio: false,
								animation: false, // 禁用动画
								interaction: {
										mode: 'index',
										intersect: false,
								},
								plugins: {
										tooltip: {
												callbacks: {
														label: (context) => {
																let label = context.dataset.label || '';
																if (label) label += ': ';
																if (context.parsed.y !== null) {
																		if (mode === 'count') {
																				label += Math.round(context.parsed.y) + ' 次';
																		} else {
																				label += '¥' + context.parsed.y.toFixed(2);
																		}
																}
																return label;
														},
														footer: (items) => {
																const total = items.reduce((a, b) => a + b.parsed.y, 0);
																if (mode === 'count') {
																		return `该时段总计: ${Math.round(total)} 次`;
																} else {
																		return `该时段总计: ¥${total.toFixed(2)}`;
																}
														}
												}
										}
								},
								scales: {
										x: { stacked: mode !== 'average', grid: { display: false } },
										y: { 
												stacked: mode !== 'average', 
												beginAtZero: true,
												title: {
														display: true,
														text: mode === 'count' ? '次数' : '金额 (元)'
												}
										}
								}
						}
				});
		}

	}))
});
