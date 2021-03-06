// Copyright 2019 The Google Research Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

goog.module('eeg_modelling.eeg_viewer.Graph');

const ChartBase = goog.require('eeg_modelling.eeg_viewer.ChartBase');
const DataTable = goog.require('google.visualization.DataTable');
const Dispatcher = goog.require('eeg_modelling.eeg_viewer.Dispatcher');
const Store = goog.require('eeg_modelling.eeg_viewer.Store');
const array = goog.require('goog.array');
const formatter = goog.require('eeg_modelling.eeg_viewer.formatter');
const {assert, assertNumber, assertString} = goog.require('goog.asserts');

/**
 * @typedef {{
 *   matcher: !RegExp,
 *   getTransformation: function(!Store.StoreData):number,
 * }}
 */
let NameMatcher;

/**
 * @typedef {{
 *   timeValue: number,
 *   xPos: number,
 *   yPos: number,
 * }}
 */
let DataPointClick;

/**
 * Regular expressions to categorize channel types within each file type.  They
 * are used to determine the relative sensitiviy applied to the channel.
 * @type {!Object<string, !Array<!NameMatcher>>}
 */
const channelNameMatchers = {
  'EEG': [
    {
      matcher: new RegExp('EKG'),
      getTransformation: (store) => 7 / (2 * store.sensitivity),
    },
    {
      matcher: new RegExp('^SZ_BIN$'),
      getTransformation: (store) => store.seriesHeight / 2,
    },
    {
      matcher: new RegExp('.*'),
      getTransformation: (store) => 7 / store.sensitivity,
    },
  ],
  'EKG': [
    {
      matcher: new RegExp('.*'),
      getTransformation: () => 20,
    },
  ],
  'ECG': [
    {
      matcher: new RegExp('.*'),
      getTransformation: () => 20,
    },
  ],
};

/** @const {number} default width of the wave event form. */
const waveEventFormWidth = 330;

/** @const {number} default height of the wave event form. */
const waveEventFormHeight = 391;

/**
 * Creates the tooltip to display on a chart point, in HTML format.
 * @param {string} timestamp Formatted time to display.
 * @param {string} columnName Name of the column of the point.
 * @param {string|number} value Y value in the point, in uV.
 * @return {string} HTML to display in tooltip.
 */
function createHTMLTooltip(timestamp, columnName, value) {
  return `<p>${timestamp}</p><p>${columnName}</p><p>${
      Number(value).toFixed(2)} ${String.fromCharCode(956)}V</p>`;
}

class Graph extends ChartBase {

  constructor() {
    super();

    this.containerId = 'line-chart-container';

    this.overlayId = 'labels-overlay';

    this.chartOptions.chartArea.backgroundColor = {};
    this.chartOptions.selectionMode = 'multiple';
    this.chartOptions.annotations = {
      boxStyle: {
        stroke: 'black',
        strokeWidth: 1,
        rx: 5,
        ry: 5,
        gradient: {
          color1: 'rgb(83, 109, 254)',
          color2: 'rgb(83, 109, 254)',
          x1: '0%', y1: '0%',
          x2: '100%', y2: '100%',
          useObjectBoundingBoxUnits: true,
        },
      },
      textStyle: {
        fontSize: 15,
        bold: false,
      },
    };
    this.chartOptions.crosshair.color = 'rgb(83, 109, 254)';
    this.chartOptions.crosshair.selected.color = 'rgb(34, 139, 34)';
    this.chartOptions.tooltip.isHtml = true;
    this.chartOptions.tooltip.trigger = 'focus';

    this.height = {
      [Store.PredictionMode.NONE]: 1.0,
      [Store.PredictionMode.CHUNK_SCORES]: 0.85,
      [Store.PredictionMode.ATTRIBUTION_MAPS]: 0.6,
    };

    /** @public {!Map<string, number>} */
    this.channelTransformations = new Map([]);

    this.chartListeners = [
      {
        type: 'click',
        handler: (event) => {
          if (!event.targetID) {
            return;
          }

          const cli = this.getChartLayoutInterface();
          const chartArea = cli.getChartAreaBoundingBox();

          const timeValue = cli.getHAxisValue(event.x);

          if (event.targetID.startsWith('point')) {
            const row = Number(event.targetID.split('#')[2]);
            this.handlePointClick(
                row, timeValue, event.x, event.y, chartArea.left);
          } else if (event.targetID.startsWith('vAxis')) {
            const seriesIndexReversed = Number(event.targetID.split('#')[3]);
            const columnIndex =
                this.seriesIndexToColumnIndex_(seriesIndexReversed, true);
            this.handleChannelNameClick(columnIndex, event.y, chartArea.left);
          }
        },
      },
    ];

    /** @private {?DataPointClick} */
    this.firstClick_ = null;

    /** @private {?DataPointClick} */
    this.secondClick_ = null;

    /** @private {?string} */
    this.clickedChannelName_ = null;

    this.overlayLayers = [
      {
        name: 'waveEvents',
        getElementsToDraw: (store) => this.drawWaveEvents(store),
      },
    ];

    /** @private @const {string} */
    this.channelActionsId_ = 'channel-actions-container';

    /** @private @const {string} */
    this.channelActionsTitleId_ = 'channel-actions-title';

    /** @private @const {string} */
    this.waveEventFormId_ = 'wave-event-form';

    /** @private @const {string} */
    this.waveEventStartTimeId_ = 'wave-event-start-time';

    /** @private @const {string} */
    this.waveEventEndTimeId_ = 'wave-event-end-time';

    const store = Store.getInstance();
    // This listener callback will update the chart with the new store data,
    // redrawing only what needs to be redrawn.
    store.registerListener(
        [
          Store.Property.ANNOTATIONS,
          Store.Property.CHUNK_GRAPH_DATA,
          Store.Property.TIMESCALE,
          Store.Property.SENSITIVITY,
          Store.Property.PREDICTION_MODE,
          Store.Property.WAVE_EVENTS,
        ],
        'Graph',
        (store, changedProperties) =>
            this.handleChartData(store, changedProperties));
  }

  /**
   * Transforms the series index to the column index of a channel.
   * The series index is the correlative order of the channels as displayed in
   * the chart, starting at the bottom of the chart, and starting at 0.
   * The column index is the index used directly in the data table.
   *
   * This function considers the following columns in the data table:
   *   0: time
   *   1: annotation
   *   2: annotationText (HTML)
   *   3: first channel
   *   4: first channel tooltip
   *   5: second channel
   *   6: second channel tooltip
   *   7: ...etc
   * E.g., if the seriesIndex is 1, the columnIndex returned should be 5.
   *
   * @param {number} seriesIndex Position of the channel in the chart.
   * @param {boolean=} reversed Indicates if the series index is reversed.
   * @return {number} Column index as it appears in the data table.
   * @private
   */
  seriesIndexToColumnIndex_(seriesIndex, reversed = false) {
    if (reversed) {
      const nCols = this.dataTable.getNumberOfColumns();
      const nChannels = (nCols - 3) / 2;
      seriesIndex = nChannels - 1 - seriesIndex;
    }

    return 3 + 2 * seriesIndex;
  }

  /**
   * Returns a cast HTML Input element.
   * @param {string} id The HTML id of the element.
   * @return {!HTMLInputElement} The input element.
   * @private
   */
  getInputElement_(id) {
    return /** @type {!HTMLInputElement} */ (document.getElementById(id));
  }

  /**
   * Sets the wave events form position considering where was the click.
   * Tries to position the form directly left to the click.
   * If not possible, tries below the click.
   * If not possible, move it above the click.
   * @param {!HTMLElement} waveEventForm Container element of the form.
   * @param {number} xPos left position of the click, relative to the viewport.
   * @param {number} yPos top position of the click, relative to the viewport.
   * @param {number} chartAreaLeft Left coordinate of the chart area.
   * @private
   */
  setWaveEventFormPosition_(waveEventForm, xPos, yPos, chartAreaLeft) {
    // If the form is hidden the offsetHeight and offsetWidth are 0, so the
    // default values are needed to calculate the position.
    const formWidth = waveEventForm.offsetWidth || waveEventFormWidth;
    const formHeight = waveEventForm.offsetHeight || waveEventFormHeight;
    let left = xPos - formWidth - 20;
    let top = yPos;
    let movedLeft = false;
    if (left < chartAreaLeft) {
      left = xPos + 10;
      top = yPos + 80;
      movedLeft = true;
    }

    const verticalLimit = window.innerHeight - formHeight - 100;
    if (top > verticalLimit) {
      const verticalMovement = movedLeft ? 200 : 20;
      top = yPos - formHeight - verticalMovement;
    }

    waveEventForm.style.left = `${left}px`;
    waveEventForm.style.top = `${top}px`;
  }

  /**
   * Handles a click in a point value, which enables the New Wave Event form.
   * @param {number} row Row of the click in the dataTable.
   * @param {number} timeValue time of the click, relative.
   * @param {number} xPos left position of the click, relative to the viewport.
   * @param {number} yPos top position of the click, relative to the viewport.
   * @param {number} chartAreaLeft Left coordinate of the chart area.
   */
  handlePointClick(row, timeValue, xPos, yPos, chartAreaLeft) {
    const waveEventForm = /** @type {!HTMLElement} */ (
        document.getElementById(this.waveEventFormId_));
    const startTimeInput = this.getInputElement_(this.waveEventStartTimeId_);
    const endTimeInput = this.getInputElement_(this.waveEventEndTimeId_);

    const prettyTime = this.dataTable.getFormattedValue(row, 0);

    if (this.firstClick_ &&
        (this.secondClick_ || timeValue < this.firstClick_.timeValue)) {
      this.firstClick_ = null;
      this.secondClick_ = null;
      this.getChart().setSelection(null);
    }

    if (!this.firstClick_) {
      startTimeInput.value = prettyTime;
      endTimeInput.value = '';

      this.setWaveEventFormPosition_(waveEventForm, xPos, yPos, chartAreaLeft);

      this.firstClick_ = {
        timeValue,
        xPos,
        yPos,
      };
    } else {
      endTimeInput.value = prettyTime;

      this.secondClick_ = {
        timeValue,
        xPos,
        yPos,
      };
    }

    waveEventForm.classList.remove('hidden');
  }

  /**
   * Selects a wave event type in the form, by setting the dropdown text in the
   * UI.
   * @param {string} type Type selected.
   */
  selectWaveEventType(type) {
    const dropdown = document.getElementById('wave-event-type-dropdown-text');
    dropdown.textContent = type;
  }

  /**
   * Closes the wave event form, clears the clicks previously made and clears
   * the chart selection.
   */
  closeWaveEventForm() {
    const waveEventForm = document.getElementById(this.waveEventFormId_);
    const startTimeInput = this.getInputElement_(this.waveEventStartTimeId_);
    const endTimeInput = this.getInputElement_(this.waveEventEndTimeId_);

    startTimeInput.value = '';
    endTimeInput.value = '';
    this.getChart().setSelection(null);

    this.firstClick_ = null;
    this.secondClick_ = null;

    waveEventForm.classList.add('hidden');
  }

  /**
   * Saves the wave event determined by the clicks made before.
   */
  saveWaveEvent() {
    if (!this.firstClick_) {
      return;
    }
    const startTime = this.firstClick_.timeValue;
    const endTime = this.secondClick_ ? this.secondClick_.timeValue : startTime;

    if (endTime < startTime) {
      return;
    }

    const labelText =
        document.getElementById('wave-event-type-dropdown-text').innerHTML;

    Dispatcher.getInstance().sendAction({
      actionType: Dispatcher.ActionType.ADD_WAVE_EVENT,
      data: {
        labelText,
        startTime,
        duration: endTime - startTime,
      },
    });
    this.closeWaveEventForm();
  }

  /**
   * @override
   */
  getHTickValues(store) {
    return array.range(store.chunkStart, store.chunkStart + store.chunkDuration,
        store.timeScale);
  }

  /**
   * @override
   */
  getVTickDisplayValues(store) {
    return store.chunkGraphData.cols.slice(1).map((x) => x.id);
  }

  /**
   * @override
   */
  getStart(store) {
    return store.chunkStart;
  }

  /**
   * @override
   */
  getNumSecs(store) {
    return store.chunkDuration;
  }

  /**
   * Derives render transformation coefficient from series ID.
   * @param {string} seriesName Name of the series of data.
   * @param {!Store.StoreData} store Store object containing request chunk data.
   * @return {number} Coefficient to multiply data series by.
   */
  getRenderTransformation(seriesName, store) {
    if (this.channelTransformations.has(seriesName)) {
      return this.channelTransformations.get(seriesName);
    }
    assert(store.sensitivity != 0);
    // Default transformation for any file or channel type.
    let transformation = 1 / store.sensitivity;
    const nameMatchers = channelNameMatchers[assertString(store.fileType)];
    if (!nameMatchers) {
      return transformation;
    }
    for (const nameMatcher of nameMatchers) {
      if (nameMatcher.matcher.test(seriesName)) {
        transformation = nameMatcher.getTransformation(store);
        break;
      }
    }
    this.channelTransformations.set(seriesName, transformation);
    return transformation;
  }

  /**
   * Staggers data series vertically, considering sensitivity and series offset.
   * @param {!Store.StoreData} store Store object containing request chunk data.
   * @param {!DataTable} dataTable instance.
   */
  formatDataForRendering(store, dataTable) {
    // Skips over the first column of data that becomes the axis values.
    for (let col = 1; col < dataTable.getNumberOfColumns(); col++) {
      const offset = this.getRenderOffset(col, store);
      const transform = this.getRenderTransformation(dataTable.getColumnId(col),
                                                     store);
      for (let row = 0; row < dataTable.getNumberOfRows(); row++) {
        if (dataTable.getValue(row, col) != null) {
          const value = Number(dataTable.getFormattedValue(row, col));
          const transformedValue = value * transform + offset;

          // The formatted value on each cell holds the actual voltage value.
          // The value holds the value with the transformation applied.
          dataTable.setValue(row, col, transformedValue);
          dataTable.setFormattedValue(row, col, value);
        }
      }
    }
  }

  /**
   * Sets formatted time in the domain column to use when rendering.
   * @param {!Store.StoreData} store Store object containing request chunk data.
   * @param {!DataTable} dataTable instance.
   */
  formatDomainForRendering(store, dataTable) {
    for (let row = 0; row < dataTable.getNumberOfRows(); row++) {
      const timeValue = dataTable.getValue(row, 0);
      const formattedTime =
          formatter.formatTime(store.absStart + timeValue, true);
      dataTable.setFormattedValue(row, 0, formattedTime);
    }
  }

  /**
   * Formats the annotations for DataTable.
   * @param {!Store.StoreData} store Store object containing request chunk data.
   * @param {!DataTable} dataTable DataTable object to add the annotations to.
   */
  addAnnotations(store, dataTable) {
    dataTable.insertColumn(1, 'string');
    dataTable.setColumnProperty(1, 'role', 'annotation');
    dataTable.insertColumn(2, 'string');
    dataTable.setColumnProperty(2, 'role', 'annotationText');
    dataTable.setColumnProperty(2, 'html', true);

    store.annotations.forEach((annotation, index) => {
      const labelText = `<p>${annotation.labelText}</p>`;
      const samplingFreq = assertNumber(store.samplingFreq);
      const startTime = assertNumber(annotation.startTime);
      // Find the closest 'x' to the actual start time of the annotation, where
      // 'x' is a point on the x-axis.  Note that the x-axis points are
      // 1/samplingFreq apart from each other.
      const x = (Math.round(startTime * samplingFreq) / samplingFreq);
      for (let row = 0; row < dataTable.getNumberOfRows(); row++) {
        if (dataTable.getValue(row, 0) == x) {
          dataTable.setValue(row, 1, 'Label');
          dataTable.setValue(row, 2, labelText);
        }
      }
    });
  }

  /**
   * Adds columns in the data table with HTML tooltips for each point in the
   * graph.
   * @param {!Store.StoreData} store Store object containing request chunk data.
   * @param {!DataTable} dataTable DataTable object to add the annotations to.
   */
  addTooltips(store, dataTable) {
    // The first data column has index 3:
    // Columns: [time, annotation, annotationText, data, ...]
    const firstDataCol = 3;

    const nRows = dataTable.getNumberOfRows();
    const nCols = dataTable.getNumberOfColumns();

    // TODO(pdpino): make the column insertion more efficient
    for (let dataCol = nCols - 1; dataCol >= firstDataCol; dataCol--) {
      const tooltipCol = dataCol + 1;
      dataTable.insertColumn(tooltipCol, 'string');
      dataTable.setColumnProperty(tooltipCol, 'role', 'tooltip');
      dataTable.setColumnProperty(tooltipCol, 'html', true);
      const channelName = dataTable.getColumnLabel(dataCol);

      for (let row = 0; row < nRows; row++) {
        const prettyTime = dataTable.getFormattedValue(row, 0);
        const value = dataTable.getFormattedValue(row, dataCol);
        const tooltipHtml = createHTMLTooltip(prettyTime, channelName, value);
        dataTable.setValue(row, tooltipCol, tooltipHtml);
      }
    }
  }

  /**
   * @override
   */
  createDataTable(store) {
    const chunkGraphData = /** @type {!Object} */ (JSON.parse(JSON.stringify(
        store.chunkGraphData)));
    const dataTable = new DataTable(chunkGraphData);
    this.formatDataForRendering(store, dataTable);
    this.formatDomainForRendering(store, dataTable);
    this.addAnnotations(store, dataTable);
    this.addTooltips(store, dataTable);
    return dataTable;
  }

  /**
   * @override
   */
  updateChartOptions(store) {
    const numSeries = store.chunkGraphData.cols.length;
    this.setOption('vAxis.viewWindow', {
       min: -store.seriesHeight * 2,
       max: store.seriesHeight * numSeries,
    });
    this.setOption('colors',
        this.generateColors(store.chunkGraphData.cols.length, '#696969'));
    super.updateChartOptions(store);
  }

  /**
   * Handles a click in a channel name, which will enable the sensitivity menu.
   * @param {number} columnIndex Column index of the channel.
   * @param {number} yPos Position of the click in the y axis.
   * @param {number} chartAreaLeft Left position of the chart area.
   */
  handleChannelNameClick(columnIndex, yPos, chartAreaLeft) {
    const channelName = this.getDataTable().getColumnId(columnIndex);

    if (channelName === this.clickedChannelName_) {
      this.closeSensitivityMenu();
      return;
    }

    this.clickedChannelName_ = channelName;

    const channelActionsContainer =
        document.getElementById(this.channelActionsId_);
    const channelActionsTitle =
        document.getElementById(this.channelActionsTitleId_);

    channelActionsContainer.style.left = `${chartAreaLeft}px`;
    channelActionsContainer.style.top = `${yPos - 20}px`;
    channelActionsTitle.textContent = this.clickedChannelName_;

    channelActionsContainer.classList.remove('hidden');
  }

  /**
   * Closes the sensitivity menu and clears the channel click information.
   */
  closeSensitivityMenu() {
    document.getElementById(this.channelActionsId_).classList.add('hidden');
    document.getElementById(this.channelActionsTitleId_).textContent = '';
    this.clickedChannelName_ = null;
  }

  /**
   * Changes the sensitivity of the clicked channel.
   * @param {number} modifier Sensitivity modifier.
   * @private
   */
  changeChannelSensitivity_(modifier) {
    const channelName = this.clickedChannelName_;
    if (!channelName || !this.updateDataAndRedrawHandler) {
      return;
    }

    const currentTransform = this.channelTransformations.get(channelName);
    this.channelTransformations.set(channelName, currentTransform * modifier);

    // TODO(pdpino): update just the selected column in the dataTable,
    // and then call this.redrawHandler() instead (for better performance).
    // If this handler is no longer used after that, delete it.
    this.updateDataAndRedrawHandler();
  }

  /**
   * Increases the sensitivity of the clicked channel.
   */
  increaseSensitivity() {
    this.changeChannelSensitivity_(2);
  }

  /**
   * Decreases the sensitivity of the clicked channel.
   */
  decreaseSensitivity() {
    this.changeChannelSensitivity_(0.5);
  }

  /**
   * Returns an array of elements that represent the wave events to draw in
   * the graph canvas.
   * @param {!Store.StoreData} store Store data.
   * @return {!Array<!ChartBase.OverlayElement>} Elements to draw in the canvas.
   */
  drawWaveEvents(store) {
    const chunkStart = store.chunkStart;
    const chunkEnd = store.chunkStart + store.chunkDuration;

    return store.waveEvents.reduce((drawElements, waveEvent) => {
      const startTime = waveEvent.startTime;
      const endTime = startTime + waveEvent.duration;

      if (startTime < chunkEnd && chunkStart < endTime) {
        drawElements.push({
          fill: true,
          color: 'rgba(144, 238, 144, 0.4)', // green
          startX: Math.max(startTime, chunkStart),
          endX: Math.min(endTime, chunkEnd),
          top: 0,
        });
      }

      return drawElements;
    }, []);
  }

  /**
   * @override
   */
  shouldBeVisible(store) {
    const shouldBeVisible = !!store.chunkGraphData;
    if (!shouldBeVisible) {
      this.channelTransformations = new Map([]);
    }
    return shouldBeVisible;
  }

  /**
   * @override
   */
  shouldUpdateData(store, changedProperties) {
    return ChartBase.changedPropertiesIncludeAny(changedProperties, [
      Store.Property.ANNOTATIONS,
      Store.Property.CHUNK_GRAPH_DATA,
      Store.Property.SENSITIVITY,
    ]);
  }

  /**
   * @override
   */
  shouldRedrawContent(store, changedProperties) {
    return ChartBase.changedPropertiesIncludeAny(changedProperties, [
      Store.Property.TIMESCALE,
      Store.Property.PREDICTION_MODE,
    ]);
  }

  /**
   * @override
   */
  shouldRedrawOverlay(store, changedProperties) {
    return ChartBase.changedPropertiesIncludeAny(changedProperties, [
      Store.Property.WAVE_EVENTS,
    ]);
  }
}

goog.addSingletonGetter(Graph);

exports = Graph;

